/**
 * HEIC/HEIF → RGBA pixels, decoded in this process.
 *
 * sharp never sees a HEIC: its prebuilt libvips carries libheif for AVIF only, with no HEVC
 * decoder, so `sharp(heic)` fails on the first byte. libheif-js is the wasm build of the same
 * library and is the one format in the app that needs it, which is why it is imported lazily —
 * `resize`, `crop`, `text` and the rest must not pay for a 2 MB module they never touch.
 *
 * This calls `heif_js_decode_image2` rather than the `display()` helper every wrapper uses.
 * `display()` sizes its buffer from `image.get_width()/get_height()`, and those are the *coded*
 * dimensions: a photo carrying `irot` (or an EXIF orientation the decoder applies) comes back with
 * its axes swapped, so the caller's buffer no longer matches the pixels and every row lands in the
 * wrong place. This call reports the decoded width/height/stride, whatever the transforms did, and
 * the transforms are applied — a portrait phone photo arrives upright.
 */

import { readFile } from 'node:fs/promises'

export interface DecodedHeif {
  width: number
  height: number
  /** RGBA, 4 bytes per pixel, rows packed at `width * 4`. */
  data: Uint8Array
}

interface HeifChannel {
  id: { value: number }
  width: number
  height: number
  stride: number
  data: Uint8Array
}

interface HeifDecoded {
  image?: unknown
  width: number
  height: number
  channels: HeifChannel[]
}

interface HeifImage {
  handle: unknown
  is_primary(): boolean
  free(): void
}

interface HeifModule {
  ready: Promise<void>
  HeifDecoder: new () => { decode(buffer: Uint8Array): HeifImage[]; decoder?: { delete(): void } }
  heif_js_decode_image2(handle: unknown, colorspace: number, chroma: number): Promise<HeifDecoded>
  heif_colorspace: { heif_colorspace_RGB: number }
  heif_chroma: { heif_chroma_interleaved_RGBA: number }
  heif_channel: { heif_channel_interleaved: number }
  heif_image_release(image: unknown): void
}

/** Decode the picture's primary image; throws with a readable reason when the container has none. */
export async function decodeHeif(file: string): Promise<DecodedHeif> {
  const libheif = (await import('libheif-js/wasm-bundle')).default as unknown as HeifModule
  await libheif.ready

  const decoder = new libheif.HeifDecoder()
  const images = decoder.decode(await readFile(file))
  if (!images.length) throw new Error(`${file}: no image found in this HEIF container`)

  try {
    const image = images.find((candidate) => candidate.is_primary()) ?? images[0]!
    const decoded = await libheif.heif_js_decode_image2(
      image.handle,
      libheif.heif_colorspace.heif_colorspace_RGB,
      libheif.heif_chroma.heif_chroma_interleaved_RGBA,
    )
    if (!decoded?.channels?.length) throw new Error(`${file}: the HEIF decoder returned no pixels`)

    try {
      const channel =
        decoded.channels.find((c) => c.id?.value === libheif.heif_channel.heif_channel_interleaved) ??
        decoded.channels[0]!
      const rowBytes = channel.width * 4
      const data =
        channel.stride === rowBytes
          ? new Uint8Array(channel.data.buffer, channel.data.byteOffset, rowBytes * channel.height)
          : packRows(channel.data, rowBytes, channel.stride, channel.height)

      return { width: channel.width, height: channel.height, data }
    } finally {
      libheif.heif_image_release(decoded.image)
    }
  } finally {
    for (const image of images) image.free()
    decoder.decoder?.delete()
  }
}

/** Drop the padding a decoder may leave at the end of each row. */
function packRows(source: Uint8Array, rowBytes: number, stride: number, height: number): Uint8Array {
  const packed = new Uint8Array(rowBytes * height)
  for (let y = 0; y < height; y++) {
    packed.set(source.subarray(y * stride, y * stride + rowBytes), y * rowBytes)
  }
  return packed
}
