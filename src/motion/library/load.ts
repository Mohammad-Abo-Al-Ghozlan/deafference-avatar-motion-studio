import { int16View, validateLibraryIndex, type SignLibraryIndex } from './format'

export const SIGN_LIBRARY_URL = '/motion/sign-library/sign-library.json'

export interface LoadedSignLibrary {
  index: SignLibraryIndex
  data: Int16Array
}

async function gunzip(bytes: Uint8Array) {
  if (typeof DecompressionStream === 'undefined') throw new Error('This browser cannot decompress the sign library (no DecompressionStream)')
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/**
 * The quaternion data as served. A host may send the .gz file as is or
 * decode it on the way (Content-Encoding: gzip): the expected byte length
 * tells the two apart, then the gzip magic is checked.
 */
export async function decodeLibraryData(index: SignLibraryIndex, served: Uint8Array): Promise<Int16Array> {
  const expected = index.data.values * 2
  if (served.byteLength === expected) return int16View(index, served)
  if (served[0] !== 0x1f || served[1] !== 0x8b) throw new Error(`Sign library data has ${served.byteLength} bytes and is not gzip (expected ${expected} bytes)`)
  return int16View(index, await gunzip(served))
}

/** Fetch and validate the index, then the quaternion data it points to (same folder). */
export async function loadSignLibrary(url = SIGN_LIBRARY_URL, signal?: AbortSignal): Promise<LoadedSignLibrary> {
  const response = await fetch(url, { signal })
  if (!response.ok) throw new Error(`Sign library index request failed (${response.status}) for ${url}`)
  const index = (await response.json()) as unknown
  validateLibraryIndex(index)
  const dataUrl = new URL(index.data.file, new URL(url, window.location.href)).toString()
  const dataResponse = await fetch(dataUrl, { signal })
  if (!dataResponse.ok) throw new Error(`Sign library data request failed (${dataResponse.status}) for ${dataUrl}`)
  return { index, data: await decodeLibraryData(index, new Uint8Array(await dataResponse.arrayBuffer())) }
}
