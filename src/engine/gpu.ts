/**
 * Getting a GPUDevice, and saying plainly why when there isn't one.
 *
 * Kept apart from the worker's message loop so that a lost device can be
 * replaced by calling the same function again: the first device and its
 * replacement come from one place and ask for the same things.
 */
import type { GpuInfo } from './protocol'

/**
 * Optional features the engine uses when they're there. Each one is a
 * speed-up or a precision gain with a fallback, never a requirement:
 * requiring one would turn a working machine into an "unsupported" page.
 *
 * - float32-filterable: sampling 32-bit float textures with a filter, for
 *   16-bit documents composited in float32.
 * - shader-f16: half floats in shaders, for 8-bit documents' scratch work.
 * - timestamp-query: GPU timings for the bench.
 */
const WANTED_FEATURES: GPUFeatureName[] = ['float32-filterable', 'shader-f16', 'timestamp-query']

/**
 * Limits raised to whatever the adapter allows. The defaults are sized for
 * web pages that draw a few sprites; a 16-bit CMYK document wants the
 * largest buffers and textures the hardware has.
 */
const RAISED_LIMITS = [
  'maxTextureDimension2D',
  'maxTextureArrayLayers',
  'maxBufferSize',
  'maxStorageBufferBindingSize',
  'maxComputeWorkgroupStorageSize',
  'maxComputeInvocationsPerWorkgroup',
  'maxComputeWorkgroupSizeX',
  'maxComputeWorkgroupSizeY',
] as const

export type Acquired =
  | { ok: true; device: GPUDevice; adapter: GPUAdapter; features: string[] }
  | { ok: false; reason: string }

export async function acquireDevice(): Promise<Acquired> {
  const gpu = (navigator as Navigator & { gpu?: GPU }).gpu
  if (!gpu) {
    return {
      ok: false,
      reason:
        'This browser has no WebGPU. Plexel draws everything on the GPU through WebGPU, which current Chrome, Edge, Safari and Firefox all have.',
    }
  }

  let adapter: GPUAdapter | null = null
  try {
    adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' })
  } catch {
    adapter = null
  }
  if (!adapter) {
    return {
      ok: false,
      reason:
        'WebGPU is there, but the browser offered no graphics adapter. It may be turned off in the browser settings, or blocked for this graphics driver. Updating the driver often fixes it.',
    }
  }

  const features = WANTED_FEATURES.filter((f) => adapter.features.has(f))
  const requiredLimits: Record<string, number> = {}
  for (const name of RAISED_LIMITS) requiredLimits[name] = adapter.limits[name]

  try {
    const device = await adapter.requestDevice({ requiredFeatures: features, requiredLimits })
    return { ok: true, device, adapter, features }
  } catch (e) {
    return {
      ok: false,
      reason: `The graphics adapter refused to start a device: ${e instanceof Error ? e.message : String(e)}`,
    }
  }
}

export function describeGpu(adapter: GPUAdapter, device: GPUDevice, canvasFormat: GPUTextureFormat, features: string[]): GpuInfo {
  const info = adapter.info
  return {
    vendor: info.vendor,
    architecture: info.architecture,
    device: info.device,
    description: info.description,
    canvasFormat,
    features,
    limits: {
      maxTextureDimension2D: device.limits.maxTextureDimension2D,
      maxTextureArrayLayers: device.limits.maxTextureArrayLayers,
      maxBufferSize: device.limits.maxBufferSize,
      maxStorageBufferBindingSize: device.limits.maxStorageBufferBindingSize,
      maxComputeWorkgroupSizeX: device.limits.maxComputeWorkgroupSizeX,
    },
  }
}
