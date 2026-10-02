import { type Mesh, type Object3D, type PerspectiveCamera, type Scene, type Texture, Clock, Vector2, WebGLRenderer } from 'three'
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js'
import { AVATAR_URL, configureRenderer } from './studioScene'

/**
 * One WebGL context for several avatar views on the same page.
 *
 * The supplied avatar carries an 8192 x 8192 texture (~360 MB of GPU memory
 * with mipmaps). Every WebGL context uploads its own copy, so N independent
 * canvases cost N copies. Here all views share ONE context and ONE parsed
 * GLB: each view gets a SkeletonUtils clone (own skeleton and pose; shared
 * geometry, material and texture), is rendered into the shared drawing buffer
 * and copied into the view's own 2D canvas in the same task.
 */
export interface AvatarView {
  canvas: HTMLCanvasElement
  scene: Scene
  camera: PerspectiveCamera
  /** Called once per animation frame before the view is drawn (pose, controls). */
  update(dt: number): void
}

export interface SharedAvatarRenderer {
  /** A new, independently posable instance of the supplied avatar. */
  cloneAvatar(): Object3D
  addView(view: AvatarView): () => void
  release(): void
}

interface RegisteredView extends AvatarView {
  context: CanvasRenderingContext2D
  visible: boolean
  observer: IntersectionObserver | null
}

class Shared {
  readonly renderer: WebGLRenderer
  readonly gltf: GLTF
  private readonly views = new Set<RegisteredView>()
  private readonly clock = new Clock()
  private readonly size = new Vector2()
  private frame = 0
  refs = 0
  disposed = false

  constructor(gltf: GLTF) {
    this.gltf = gltf
    this.renderer = new WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' })
    // Views size themselves in device pixels; the shared buffer only grows.
    this.renderer.setPixelRatio(1)
    configureRenderer(this.renderer)
    this.renderer.setScissorTest(true)
    const loop = () => {
      this.frame = requestAnimationFrame(loop)
      this.draw(this.clock.getDelta())
    }
    this.frame = requestAnimationFrame(loop)
  }

  add(view: AvatarView) {
    const context = view.canvas.getContext('2d', { alpha: false })
    if (!context) throw new Error('2D canvas is not available for the avatar view')
    const entry: RegisteredView = { ...view, context, visible: true, observer: null }
    if (typeof IntersectionObserver !== 'undefined') {
      entry.observer = new IntersectionObserver((records) => {
        for (const record of records) entry.visible = record.isIntersecting
      }, { rootMargin: '120px' })
      entry.observer.observe(view.canvas)
    }
    this.views.add(entry)
    return () => {
      entry.observer?.disconnect()
      this.views.delete(entry)
    }
  }

  private draw(dt: number) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    for (const view of this.views) {
      view.update(dt)
      if (!view.visible) continue
      const width = Math.round(view.canvas.clientWidth * dpr)
      const height = Math.round(view.canvas.clientHeight * dpr)
      if (width < 2 || height < 2) continue
      if (view.canvas.width !== width || view.canvas.height !== height) {
        view.canvas.width = width
        view.canvas.height = height
      }
      this.renderer.getSize(this.size)
      if (this.size.x < width || this.size.y < height) {
        this.renderer.setSize(Math.max(this.size.x, width), Math.max(this.size.y, height), false)
      }
      if (view.camera.aspect !== width / height) {
        view.camera.aspect = width / height
        view.camera.updateProjectionMatrix()
      }
      this.renderer.setViewport(0, 0, width, height)
      this.renderer.setScissor(0, 0, width, height)
      this.renderer.render(view.scene, view.camera)
      // GL's origin is bottom-left: the view occupies the bottom rows of the buffer.
      const buffer = this.renderer.domElement
      view.context.drawImage(buffer, 0, buffer.height - height, width, height, 0, 0, width, height)
    }
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    cancelAnimationFrame(this.frame)
    for (const view of this.views) view.observer?.disconnect()
    this.views.clear()
    // The template asset owns the shared geometry, materials and textures.
    const textures = new Set<Texture>()
    this.gltf.scene.traverse((node) => {
      const mesh = node as Mesh
      if (!mesh.isMesh) return
      mesh.geometry?.dispose()
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
      for (const material of materials) {
        if (!material) continue
        for (const value of Object.values(material)) if ((value as Texture | null)?.isTexture) textures.add(value as Texture)
        material.dispose()
      }
    })
    textures.forEach((texture) => texture.dispose())
    this.renderer.dispose()
    // Free the ~360 MB texture now instead of whenever the context is collected.
    this.renderer.forceContextLoss()
  }
}

let current: Promise<Shared> | null = null

/**
 * Reference-counted access to the page's shared avatar renderer. The GLB is
 * loaded on first use; the context and the asset are freed when the last
 * holder releases it.
 */
export async function acquireSharedAvatarRenderer(): Promise<SharedAvatarRenderer> {
  const loading = (current ??= new GLTFLoader().loadAsync(AVATAR_URL).then((gltf) => new Shared(gltf)))
  let instance: Shared
  try {
    instance = await loading
  } catch (error) {
    if (current === loading) current = null // allow a retry after a failed load
    throw error
  }
  if (instance.disposed) return acquireSharedAvatarRenderer()
  instance.refs += 1
  let released = false
  return {
    cloneAvatar: () => cloneSkinned(instance.gltf.scene),
    addView: (view) => instance.add(view),
    release: () => {
      if (released) return
      released = true
      instance.refs -= 1
      if (instance.refs > 0) return
      if (current === loading) current = null
      instance.dispose()
    }
  }
}
