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

- On the glasses, image updates cannot exceed 10 per second in total, across all tiles. A one-tile animation is limited to 10 fps, a two-tile animation to 5 fps, and Bluetooth will lower both further.
- The simulator does not apply the 100 ms pacing. It ran the one-tile coin at 30 fps. Use simulator frame rates to check behaviour, not speed.
- The `FrameLoop` design suits this link. It always renders the newest frame after the previous one is delivered, so a slow link lowers the frame rate without slowing the animation or building a backlog.
- Tiles update one at a time, so content that moves across two tiles can tear. Keep animated content inside one tile.
- Static content costs nothing after its first frame, because the engine sends only tiles whose pixels changed.

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

- the real time to send one 288×144 tile over Bluetooth, and therefore the achievable frame rate;
- whether the glasses decode the engine's PNG output the same way the simulator does;
- the panel's response curve, to set `gamma`;
- how readable small engine-rendered text is at each brightness level;
- battery cost per image update compared with a native text update.
