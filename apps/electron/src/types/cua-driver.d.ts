/**
 * `@trycua/cua-driver` ships no type declarations (its API is generated UniFFI bindings), and it is
 * an **optional** dependency: a build without it must still compile. The manager treats it
 * structurally at the boundary, so the module itself is declared loosely here rather than pulled in.
 */
declare module '@trycua/cua-driver' {
  export const CuaDriver: any
  export const EmbeddedCuaDriverHost: any
  export const EmbeddedDriverHostOptions: any
  export const EmbeddedPermissionMode: any
  const other: any
  export default other
}
