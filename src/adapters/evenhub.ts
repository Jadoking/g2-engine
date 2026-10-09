// Thin Even Hub binding: maps engine tiles to SDK image containers and
// serializes every bridge call (the SDK requires one image update at a time).
import {
  ImageContainerProperty,
  ImageRawDataUpdate,
  ImageRawDataUpdateResult,
  type EvenAppBridge,
} from '@evenrealities/even_hub_sdk';
import type { Rect } from '../surface.ts';
import type { TileSink } from '../engine.ts';

export const FIRST_TILE_ID = 10;

export type Serial = <T>(task: () => Promise<T>) => Promise<T>;

/** Run tasks one after another, in call order, even if earlier ones fail. */
export function serialQueue(): Serial {
  let tail: Promise<unknown> = Promise.resolve();
  return (task) => {
    const run = tail.then(task, task);
    tail = run.catch(() => undefined);
    return run;
  };
}

export function tileName(index: number): string {
  return `g2e-tile-${index}`;
}

export function imageContainers(tiles: readonly Rect[]): ImageContainerProperty[] {
  return tiles.map((t, i) => new ImageContainerProperty({
    containerID: FIRST_TILE_ID + i,
    containerName: tileName(i),
    xPosition: t.x,
    yPosition: t.y,
    width: t.width,
    height: t.height,
  }));
}

export function evenHubSink(bridge: EvenAppBridge, serial: Serial): TileSink {
  return (index, png) => serial(async () => {
    const result = await bridge.updateImageRawData(new ImageRawDataUpdate({
      containerID: FIRST_TILE_ID + index,
      containerName: tileName(index),
      imageData: png,
    }));
    if (result !== ImageRawDataUpdateResult.success) throw new Error(`tile ${index}: ${String(result)}`);
  });
}
