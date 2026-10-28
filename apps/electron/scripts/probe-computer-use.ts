/**
 * One-off calibration probe for the desktop driver.
 *
 * The SDK ships no `.d.ts`, so the method names in
 * `src/main/computer-use-manager.ts` are a guess until this prints the real ones. Run:
 *
 *   cd apps/electron && bun scripts/probe-computer-use.ts
 *
 * Nothing here writes to the machine except what `driving` below asks for, and that part is opt-in.
 */
const pkg = await import('@trycua/cua-driver')

const names = Object.keys(pkg).sort()
console.log(`exports (${names.length}):`, names.join(', '))

function dump(label: string, value: unknown) {
  if (typeof value !== 'function') {
    console.log(`\n${label}: ${typeof value}`, value && typeof value === 'object'
      ? Object.keys(value as object).slice(0, 20) : '')
    return
  }
  const statics = Object.getOwnPropertyNames(value).filter(
    (key) => !['length', 'name', 'prototype'].includes(key),
  )
  const proto = Object.getOwnPropertyNames((value as { prototype?: object }).prototype ?? {})
  console.log(`\n${label}:`)
  console.log('  static:', statics.join(', ') || '(none)')
  console.log(`  proto (${proto.length}):`, proto.slice(0, 80).join(', '))
}

for (const name of ['CuaDriver', 'EmbeddedCuaDriverHost', 'EmbeddedDriverHostOptions', 'EmbeddedPermissionMode', 'EmbeddedMcpConfiguration', 'SdkClientKind']) {
  dump(name, (pkg as Record<string, unknown>)[name])
}

const driving = process.argv.includes('--drive')

if (driving) {
  const anyPkg = pkg as unknown as {
    CuaDriver?: { create?: (options: unknown) => Promise<unknown> }
  }
  if (!anyPkg.CuaDriver?.create) {
    console.log('\nno CuaDriver.create — cannot drive from this entry point')
    process.exit(0)
  }
  console.log('\ncreating driver…')
  const driver = (await anyPkg.CuaDriver.create({})) as Record<string, unknown>
  const proto = Object.getOwnPropertyNames(Object.getPrototypeOf(driver))
  console.log('instance proto:', proto.slice(0, 80).join(', '))
  const asAny = driver as Record<string, (...args: unknown[]) => unknown>
  for (const candidate of ['listWindows', 'list_windows', 'windows']) {
    if (typeof asAny[candidate] === 'function') {
      console.log(`calling ${candidate}()…`)
      try {
        console.log(JSON.stringify(await asAny[candidate]!(), null, 2).slice(0, 2000))
      } catch (error) {
        console.log(`  failed: ${String(error)}`)
      }
      break
    }
  }
}

process.exit(0)
