# Architecture

This page describes how a frame gets from your drawing code to the G2 display, and the rules the code follows.

## Design rules

1. The core in `src/` does not import the Even Hub SDK, the DOM, or a canvas. It runs unchanged in Node (for tests and offline renders) and in the Even Hub WebView.
2. `src/adapters/evenhub.ts` is the only file that talks to the SDK. Code for another transport, such as a recorder or a network bridge, goes in a new adapter and needs no change to the core.
3. Output is deterministic. The same drawing produces the same PNG bytes on every platform, so change detection and tests can compare bytes directly.
4. Pixels stay as floating-point intensity until the engine sends a frame. Quantization to 16 levels happens in one place, at present time.
5. The engine sends nothing that the glasses already show.

## Pipeline

```text
your draw function
      │  writes intensity 0..1 per pixel
      ▼
Surface (576×288 Float32Array)
      │  Engine.present(), for each tile
      ▼
quantize ──► levels 0..15 for this tile
      │
      ├── same as the levels the glasses already show? ──► skip the tile
      │
      ▼
encodeGrayPng ──► TileSink(tileIndex, png)
                       │  Even Hub adapter
                       ▼
               bridge.updateImageRawData, one call at a time
```

### Surface

`Surface` holds one float per pixel for the whole 576×288 screen.
`Surface.shade(rect, shader, samples)` calls `shader(x, y)` for every pixel in `rect`.
Pixel centres sit at `x + 0.5, y + 0.5`.
With `samples = n`, it averages an n×n grid of sub-pixel points, which anti-aliases edges at n² times the cost.
Shaders can also do their own anti-aliasing more cheaply. The coin traces 4 rays for coverage and shades once per pixel.

You can also write `surface.data` directly, for example to blit a sprite or draw text from a bitmap font.

### Tiles

The G2 display is 576×288 pixels with 16 brightness levels.
An Even Hub page can hold at most 4 image containers, each between 20×20 and 288×144 pixels.
The engine calls each image container a tile.
`validateTiles` checks a tile layout against these limits and rejects overlapping tiles.

Covering the full screen with images takes all four tiles, as 288×144 quadrants.
Most apps should cover only the regions that need custom pixels and use native text elsewhere.

Tiles update one at a time. There is no call that swaps several tiles at once.
Content that moves across a tile boundary can therefore show two different frames for a moment (tearing).
Put animated content inside a single tile when you can.

### Change tracking

For each tile, the engine stores the 16-level pixels that the glasses last accepted.
`present()` quantizes each tile and compares the result with that stored copy.
It encodes and sends only the tiles that differ.

The comparison runs on quantized levels, not on floats.
A change smaller than half a brightness level produces the same levels, so the engine sends nothing.

The engine updates its stored copy only after the sink's promise resolves.
If a send fails, the tile still counts as changed, and the next `present()` sends it again.
Call `invalidate()` after anything that clears the glasses, such as a page rebuild or a reconnect, to force every tile to be resent.

### Encoding

`encodeGrayPng` writes a grayscale PNG at 4 or 8 bits per pixel.

- At 4 bits, each pixel stores its level 0..15 directly. A 288×144 tile is about 21 KB.
- At 8 bits, each pixel stores `level × 17`, so the values are 0, 17, 34 and so on up to 255. Converting 8-bit gray to 4-bit with either `v >> 4` or `round(v / 17)` gives back exactly the original level, so the app's own conversion does not shift any pixel.

The engine defaults to 4 bits.

The encoder uses uncompressed deflate blocks.
The PNG travels only from the WebView to the Even app on the same phone.
The SDK README says image data is compressed with LZ4 internally to reduce transfer size, so the engine does not spend phone CPU on deflate.
On the glasses, the PNG size made no difference: a 4-bit and an 8-bit PNG of the same image took the same time, and same-size PNGs with different content took between 0.2 and 3.3 s ([measurements](g2-platform.md#measured-on-glasses)). What costs time is the detail in the pixels, so compressing the PNG would not help.
The `KB/frame` figure the demo reports is the PNG size handed to the bridge, not the number of bytes sent over Bluetooth.

The SDK types describe `imageData` only as grayscale bytes.
The simulator displays these PNGs correctly. That the glasses accept the same format is still to be confirmed on hardware.

### Dither

`quantize` supports `dither: 'none'` and `dither: 'bayer4'`.
The Bayer threshold depends on the screen position of the pixel, not its position inside the tile.
Tiles that touch therefore continue the same pattern across the seam.
Because the pattern does not move between frames, a static region stays identical from frame to frame and costs nothing to keep on screen.

Use no dither for text and line art. Bayer dither smooths gradients, but it adds high-frequency detail that a 16-level display may show as texture.

### Gamma

`gamma` applies `intensity^(1/gamma)` before quantizing.
The default of 1 does nothing.
The real response curve of the G2 panel is not measured yet. The simulator shows only about 10 distinct levels, so it cannot be used to calibrate it.

## Frame loop

`FrameLoop` drives an animation:

1. Measure the wall-clock time since the previous frame (`dt`).
2. Call your draw function with `dt` and the total animation time.
3. Await `engine.present()`.
4. Sleep only if the frame took less than `1000 / maxFps` milliseconds.

The loop never starts a new frame before the previous one has been delivered.
On a slow link it renders fewer frames, but each one uses the current time.
The animation keeps its real speed, and the glasses never receive a backlog of old frames.
A unit test checks this with a simulated link that takes 250 ms per tile.

If `present()` throws, the loop reports the error through `onError`, waits 500 ms, and tries again.
The tiles that were not delivered are still marked as changed, so the retry sends them.

`onStats` reports, once per `statsIntervalMs`, the frame rate and the average draw time, present time, tiles per frame and bytes per frame.

## Native text and raster together

An Even Hub page can mix up to 8 text containers with the 4 image containers.
Native text is cheap to update, because only the string goes over the link.
Engine-drawn tiles cost a full image per update but give full control over the pixels.
The coin demo uses both on one page: the coin is two tiles and the labels are native text.

The engine does not yet pick between the two automatically.
The plan is to choose per region: native text for content that changes often, raster for typography, Japanese and layout, and more native text when the battery is low.

## Power

We expect two things to dominate the power cost of what the engine shows: how many pixels are lit and how bright they are, and how many bytes go over Bluetooth.
Drawing a frame on the phone takes a few milliseconds of CPU.
Because the engine sends nothing when nothing changed, a static screen costs no radio traffic after the first frame.
None of this has been measured on hardware yet.
