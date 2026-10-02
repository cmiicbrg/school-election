import { Type, type TProperties } from 'typebox'

/**
 * An object schema that rejects unknown properties. Every request and
 * response schema uses it: request bodies are refused rather than silently
 * trimmed, and a response cannot carry a field nobody declared.
 */
export function StrictObject<P extends TProperties>(properties: P) {
  return Type.Object(properties, { additionalProperties: false })
}

export const ErrorResponse = StrictObject({
  error: Type.String(),
  message: Type.Optional(Type.String()),
})

export const HealthResponse = StrictObject({
  status: Type.Union([Type.Literal('ok'), Type.Literal('degraded')]),
  db: Type.Union([Type.Literal('up'), Type.Literal('down')]),
})
