import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { hasInlinedPhotonDirname, PHOTON_WASM_FILENAME } from '../../../scripts/build/photon-wasm.ts';

/**
 * The image pipeline, against the BUILT bundle, from a directory outside the repo.
 *
 * Before an attachment reaches the model the Pi SDK decodes and resizes it with
 * `@silvia-odwyer/photon-node` — a WASM module it loads from a path derived from
 * `__dirname`, which `bun build` inlines as a literal of the *building* machine.
 * With the wasm never packaged, that path was the only place it could be found,
 * so on any other machine `loadPhoton()` returned null for every image, of any
 * size or format, and each attachment was replaced by
 * "[Image omitted: could not be resized below the inline image size limit.]".
 * The model was blind, and nothing about the image or the model config helped.
 *
 * Source-mode tests cannot see that, and neither can any test run on the build
 * machine — there the stale path happens to exist. So this one asserts the
 * artifact as well as the behaviour:
 *
 *   1. the bundle carries no build-machine directory for the wasm,
 *   2. the wasm travels beside the bundle, and
 *   3. driving the bundle with an image actually puts image bytes in the
 *      request — the request body being where the SDK writes that placeholder
 *      instead. A local server plays the endpoint, so nothing leaves the box.
 */

const packageDir = dirname(import.meta.dir);
const distDir = join(packageDir, 'dist');
const bundlePath = join(distDir, 'index.js');
const RUN_TIMEOUT_MS = 30_000;

let scratchDir: string;
/** The bundle as it travels: copied out of the build tree, so anything missing
 *  beside it is missing for real. */
let shippedDir: string;

beforeAll(() => {
  const build = spawnSync('bun', ['run', 'build'], { cwd: packageDir, stdio: 'pipe', timeout: 120_000 });
  if (build.status !== 0) {
    throw new Error(`bundle build failed: ${build.stderr?.toString() ?? build.stdout?.toString()}`);
  }
  scratchDir = mkdtempSync(join(tmpdir(), 'pi-bundle-images-'));
  shippedDir = join(scratchDir, 'shipped');
  mkdirSync(shippedDir, { recursive: true });
  copyFileSync(bundlePath, join(shippedDir, 'index.js'));
  copyFileSync(join(distDir, PHOTON_WASM_FILENAME), join(shippedDir, PHOTON_WASM_FILENAME));
  mkdirSync(join(scratchDir, 'work', 'plans'), { recursive: true });
});

afterAll(() => {
  if (scratchDir) rmSync(scratchDir, { recursive: true, force: true });
});

/** Subprocess environment with no ambient provider keys, auth files, or proxies. */
function createEnvironment(): NodeJS.ProcessEnv {
  const workDir = join(scratchDir, 'work');
  const env: NodeJS.ProcessEnv = {
    HOME: workDir,
    USERPROFILE: workDir,
    XDG_CONFIG_HOME: workDir,
    TMPDIR: workDir,
    TEMP: workDir,
    TMP: workDir,
  };
  for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT'] as const) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

// --- A PNG to send, built here so the test carries no binary blob ------------

function crc32(bytes: Uint8Array): number {
  let crc = ~0;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const chunk = new Uint8Array(12 + data.length);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.length);
  chunk.set(new TextEncoder().encode(type), 4);
  chunk.set(data, 8);
  view.setUint32(8 + data.length, crc32(chunk.subarray(4, 8 + data.length)));
  return chunk;
}

/** 32×32 RGB PNG — small, decodable by the SDK's image pipeline. */
function makePng(size = 32): Uint8Array {
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, size);
  view.setUint32(4, size);
  header[8] = 8; // bit depth
  header[9] = 2; // truecolour RGB
  const raw = new Uint8Array(size * (1 + size * 3));
  for (let y = 0; y < size; y++) {
    const row = y * (1 + size * 3);
    for (let x = 0; x < size; x++) {
      const pixel = row + 1 + x * 3;
      raw[pixel] = x * 8;
      raw[pixel + 1] = y * 8;
      raw[pixel + 2] = 128;
    }
  }
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', new Uint8Array(deflateSync(raw))),
    pngChunk('IEND', new Uint8Array()),
  ];
  const png = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    png.set(part, offset);
    offset += part.length;
  }
  return png;
}

/** Drive the shipped bundle in JSONL until the endpoint has been called. */
async function driveUntilRequest(): Promise<{ status: number; requestBody: string }> {
  const workDir = join(scratchDir, 'work');
  let requestBody = '';

  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      requestBody = await request.text();
      // Answer in whichever shape was asked for; only the request matters here.
      if (/"stream"\s*:\s*true/.test(requestBody)) {
        const chunk = (delta: unknown, finish: string | null) =>
          `data: ${JSON.stringify({ id: 'img', object: 'chat.completion.chunk', created: 1, model: 'probe-vision', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
        return new Response(chunk({ role: 'assistant', content: 'ok' }, null) + chunk({}, 'stop') + 'data: [DONE]\n\n', {
          headers: { 'content-type': 'text/event-stream' },
        });
      }
      return Response.json({
        id: 'img',
        object: 'chat.completion',
        created: 1,
        model: 'probe-vision',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    },
  });

  const child = spawn(process.execPath, [join(shippedDir, 'index.js')], {
    cwd: workDir,
    env: createEnvironment(),
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  try {
    await new Promise<void>((resolve, reject) => {
      let output = '';
      let prompted = false;
      const timer = setTimeout(() => reject(new Error(`timed out; output so far:\n${output.slice(-2000)}`)), RUN_TIMEOUT_MS);
      const onData = (chunk: Buffer) => {
        output += chunk.toString();
        if (!prompted && output.includes('"type":"ready"')) {
          prompted = true;
          child.stdin.write(
            `${JSON.stringify({
              type: 'prompt',
              id: 'p1',
              message: 'What is in this image?',
              systemPrompt: 'You are an image probe.',
              images: [{ type: 'image', data: Buffer.from(makePng()).toString('base64'), mimeType: 'image/png' }],
            })}\n`,
          );
        }
        if (requestBody) {
          clearTimeout(timer);
          resolve();
        }
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      child.on('error', reject);
      child.on('exit', () => {
        if (!requestBody) reject(new Error(`bundle exited before the request; output:\n${output.slice(-2000)}`));
      });

      child.stdin.write(
        `${JSON.stringify({
          type: 'init',
          apiKey: '',
          model: 'pi/probe-vision',
          cwd: workDir,
          thinkingLevel: 'off',
          workspaceRootPath: workDir,
          sessionId: 'bundle-images',
          sessionPath: workDir,
          workingDirectory: workDir,
          plansFolderPath: join(workDir, 'plans'),
          providerType: 'custom-endpoint',
          baseUrl: `http://127.0.0.1:${server.port}/v1`,
          customEndpoint: { api: 'openai-completions' },
          customModels: [{ id: 'probe-vision', name: 'Probe Vision', supportsImages: true }],
        })}\n`,
      );
    });
  } finally {
    child.kill();
    server.stop(true);
  }

  return { status: requestBody ? 200 : 0, requestBody };
}

describe('pi-agent-server bundle: images', () => {
  it('ships the photon wasm beside the bundle, with no build-machine path', () => {
    expect(existsSync(join(shippedDir, PHOTON_WASM_FILENAME))).toBe(true);
    expect(hasInlinedPhotonDirname(readFileSync(join(shippedDir, 'index.js'), 'utf8'))).toBe(false);
  });

  it('sends image bytes to the model instead of the omission placeholder', async () => {
    const { status, requestBody } = await driveUntilRequest();

    expect(status).toBe(200);
    expect(requestBody).not.toContain('Image omitted');
    expect(requestBody).toContain('image_url');
  }, RUN_TIMEOUT_MS + 10_000);
});
