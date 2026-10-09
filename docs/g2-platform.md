# G2 display and SDK limits

g2-engine is built around the constraints below.
Sources are the [Even Hub display documentation](https://hub.evenrealities.com/docs/build/display) (last updated 2026-08-25), the type definitions and README of `@evenrealities/even_hub_sdk` 0.0.16, and our own tests in the Even Hub simulator 0.9.5.
Each item names its source.

## Display

- Each eye shows a 576×288 pixel canvas with the origin at the top left. (Even Hub docs)
- Color is 4-bit greyscale, which the glasses show as 16 levels of green. Level 0 is off and transparent. (Even Hub docs)
- In simulator screenshots, we could distinguish only about 10 levels. Do not calibrate gamma or contrast against the simulator. (Our tests)

## Containers

- A page holds at most 4 image containers and at most 8 other containers. (Even Hub docs and SDK types)
- An image container is 20 to 288 pixels wide and 20 to 144 pixels high. (SDK types)
- Exactly one container on a page must have `isEventCapture: 1`. That container receives all input. (Even Hub docs)
- Image containers start empty. Their pixels are sent with `updateImageRawData` after the page exists. (Even Hub docs)
- For an image-first page, Even recommends a full-screen text container with `content: ' '` and `isEventCapture: 1` behind the images to collect input. (Even Hub docs)
- Text containers use one firmware font, with no control over size, family or weight. Characters missing from the font are dropped without an error. (Even Hub docs)
- `textColor` on text containers has 5 brightness levels, 0 to 4. Borders use the 16-level scale. (Even Hub docs)

These limits are why the engine exists.
Image containers are the only way to choose your own fonts, render Japanese with the line breaking you want, or animate.

## Sending images

- Image sends must not run concurrently. (Even Hub docs) The adapter sends one bridge call at a time through `serialQueue`.
- Since SDK 0.0.14, each `updateImageRawData` holds the image path for 100 ms. A call that arrives inside that window is held until the window ends. Nothing is dropped. (Even Hub docs)
- Image data is LZ4-compressed in transit by the SDK since 0.0.12. (Even Hub docs, SDK README)
- An `ImageRawDataUpdateResult` of `success` means the host accepted the update, not that the pixels are on the display. (Even Hub docs)
- The docs say a single frame takes far longer than 100 ms to cross Bluetooth, so the 100 ms pacing is rarely the limit. (Even Hub docs)

What this means for animation:

- On the glasses, every image update costs at least about 150 ms, so image updates top out near 6 to 7 per second in total, across all tiles. Detailed content costs much more (see [Measured on glasses](#measured-on-glasses)).
- The simulator applies neither the 100 ms pacing nor the Bluetooth cost. It ran the one-tile coin at 30 fps. Use simulator frame rates to check behaviour, not speed.
- The `FrameLoop` design suits this link. It always renders the newest frame after the previous one is delivered, so a slow link lowers the frame rate without slowing the animation or building a backlog.
- Tiles update one at a time, so content that moves across two tiles can tear. Keep animated content inside one tile.
- Static content costs nothing after its first frame, because the engine sends only tiles whose pixels changed.

## Measured on glasses

One run of `demos/link-probe` on 2026-10-09: G2 glasses, iPhone on iOS 18.7, Even Hub SDK 0.0.16.
Each case sent 4 updates in each of 2 rounds, and the first update of each block was dropped as warm-up.
All 168 updates succeeded. Times are the median of 6, measured around the `updateImageRawData` call.

| Tile | All black | One flat gray | Coin | Random noise |
| --- | --- | --- | --- | --- |
| 288×144 | 203 ms | 178 ms | 510 ms | 3264 ms |
| 144×144 | 178 ms | 162 ms | 452 ms | 1677 ms |
| 72×72 | 148 ms | 148 ms | 249 ms | 478 ms |
| 24×24 | 149 ms | 149 ms | 164 ms | 179 ms |

A native text update (`textContainerUpgrade`, about 60 characters) took 59 ms.

What the run shows:

- **There is a fixed cost of about 150 ms per image update.** Even a 24×24 all-black tile took 149 ms. That is above the 100 ms pacing rule, so the pacing is not the limit.
- **After that, time depends on how much detail the image has, not on the PNG size.** The 288×144 PNGs were all 20,948 bytes, yet black took 203 ms and noise took 3264 ms. An 8-bit PNG of the coin (41,684 bytes) took the same time as the 4-bit one. This fits the host decoding the PNG and compressing the pixels again before Bluetooth.
- **Incompressible pixels cross at roughly 7 KB per second,** assuming the glasses receive 4 bits per pixel: noise cost about 0.15 ms per byte at 288×144 and 144×144.
- **Empty space is nearly free.** The same coin cost 510 ms in a 288×144 tile and 452 ms in a 144×144 tile. Trimming a tile to its content saves little; reducing detail saves a lot.
- **Sending unchanged pixels costs the full price.** The host does not skip an identical image, so the engine's own changed-tile check matters.
- **Idle time does not change the cost.** Waiting 400 ms before each send gave the same times, and round 2 matched round 1.
- Times come in steps of about 30 ms (148, 178, 207 ms), which is likely the Bluetooth connection interval. Not confirmed.
- The battery read 90% before and after the 88-second run. One-percent resolution is too coarse to measure the cost of a short run.

## Input

The SDK reports input as `OsEventTypeList` values on `textEvent` or `sysEvent`. (SDK types)

| Value | Event |
| --- | --- |
| 0 | `CLICK_EVENT`, a single tap |
| 1 | `SCROLL_TOP_EVENT`, swipe up |
| 2 | `SCROLL_BOTTOM_EVENT`, swipe down |
| 3 | `DOUBLE_CLICK_EVENT` |
| 4, 5 | foreground enter and exit |
| 6, 7 | abnormal exit and system exit |
| 8 | `IMU_DATA_REPORT` |
| 9, 10 | `LONG_PRESS_EVENT` and `LONG_PRESS_RELEASE_EVENT` |

In the simulator, a tap arrived with no `eventType` field at all, because protobuf leaves out fields that hold the default value 0.
Treat a missing `eventType` as `CLICK_EVENT`. (Our tests)

## Page lifecycle

- `createStartUpPageContainer` returns `StartUpPageCreateResult`: 0 success, 1 invalid, 2 oversize, 3 out of memory. (SDK types)
- After a hot reload in the same simulator session, `createStartUpPageContainer` returned 1 because a page already existed. The coin demo then calls `rebuildPageContainer` with the same containers. (Our tests)
- After `rebuildPageContainer`, image containers are empty again. Call `engine.invalidate()`, or create a new `Engine`, so that every tile is sent again.

## Simulator automation

The simulator can expose an HTTP API for scripted tests with `--automation-port <port>`. (Our tests, simulator 0.9.5)

- `GET /api/ping` checks that the simulator is up.
- `GET /api/console` returns recent WebView console entries as `{ entries: [{ message, level }], total }`. It is a ring buffer that the simulator's own bridge logging fills quickly, so read your markers soon after they are logged.
- `GET /api/screenshot/glasses` returns a 576×288 RGBA PNG. Brightness is in the alpha channel, so composite it on black before you look at it.
- `POST /api/input` with `{"action": "..."}` sends input. Actions we used are `click`, `double_click`, `up`, `down`, `long_press` and `long_press_release`.

## Not known yet

These need physical glasses:

- whether the glasses show the engine's PNG output exactly as the simulator does (they accept it, but nobody has compared pixels);
- whether fewer gray levels or long runs of one level make an image cheaper to send, as the compression result suggests;
- the panel's response curve, to set `gamma`;
- how readable small engine-rendered text is at each brightness level;
- battery cost per image update compared with a native text update.
