declare module 'gltf-validator' {
  export interface ValidationMessage {
    code: string
    message: string
    severity: number
    pointer?: string
    offset?: number
  }
  export interface ValidationReport {
    issues: { numErrors: number; numWarnings: number; numInfos: number; numHints: number; messages: ValidationMessage[]; truncated: boolean }
    info?: Record<string, unknown>
  }
  export function version(): string
  export function validateBytes(data: Uint8Array, options?: { maxIssues?: number; ignoredIssues?: string[]; uri?: string }): Promise<ValidationReport>
  const validator: { version: typeof version; validateBytes: typeof validateBytes }
  export default validator
}
