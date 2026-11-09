/**
 * 发布前自检：node scripts/check.js
 *
 *   - package.json 里 files / exports / dsh.bundle.patch 指向的文件都存在；
 *   - 所有 JS 能通过 node --check；Host 半边只引用 node: 内置模块和本包文件；
 *     Client 半边不 import、只 require('react')；
 *   - locale/*.json 是 { meta: { title, description } }，并且有 en.json；
 *   - 图标是 SVG/PNG/JPEG/WebP 且不超过 256 KiB；
 *   - 有 repository 和 engines.dsh；screenshots.json 和 README 里引用的图片都存在；
 *   - client.js 的样式只用主题令牌（--dsw-alias-* 等）和 composer 布局变量。
 *
 * 有问题时逐条打印并以退出码 1 结束。
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const problems = []
const fail = (message) => problems.push(message)
const read = (path) => readFileSync(join(root, path), 'utf8')

const pkg = JSON.parse(read('package.json'))

// files：支持 dir/*.ext 这种单层通配
function expand(pattern) {
  if (!pattern.includes('*')) return existsSync(join(root, pattern)) ? [pattern] : []
  const dir = dirname(pattern)
  const suffix = pattern.slice(pattern.lastIndexOf('*') + 1)
  if (!existsSync(join(root, dir))) return []
  return readdirSync(join(root, dir)).filter((name) => name.endsWith(suffix)).map((name) => join(dir, name))
}
const shipped = new Set()
for (const pattern of pkg.files ?? []) {
  const found = expand(pattern)
  if (found.length === 0) fail(`files: "${pattern}" matches nothing`)
  for (const file of found) shipped.add(file)
}

for (const [key, target] of Object.entries(pkg.exports ?? {})) {
  const files = expand(target.replace(/^\.\//u, ''))
  if (files.length === 0) fail(`exports["${key}"]: ${target} does not exist`)
  for (const file of files) if (!shipped.has(file) && file !== 'package.json') fail(`exports["${key}"]: ${file} is not listed in files`)
}

const patch = pkg.dsh?.bundle?.patch
if (typeof patch !== 'string' || !existsSync(join(root, patch))) fail('dsh.bundle.patch is missing or points nowhere')
else if (!read(patch).includes(`name: '${pkg.name}'`) && !read(patch).includes(`name: "${pkg.name}"`) && !read(patch).includes(`name: ${pkg.name}`)) {
  fail(`${patch} does not load the package by its name "${pkg.name}"`)
}
if (pkg.exports?.['./client'] === undefined) fail('exports["./client"] is missing (the web client entry)')
if (!/^\d+\.\d+\.\d+(?:-[0-9a-z.-]+)?$/iu.test(pkg.version ?? '')) fail(`version "${pkg.version}" is not semver`)

// JS 语法和依赖
const jsFiles = [...shipped].filter((file) => file.endsWith('.js'))
for (const file of jsFiles) {
  const result = spawnSync(process.execPath, ['--check', join(root, file)], { encoding: 'utf8' })
  if (result.status !== 0) fail(`${file}: syntax error\n${result.stderr.trim()}`)
}
for (const file of jsFiles.filter((name) => name !== 'client.js')) {
  for (const match of read(file).matchAll(/^\s*(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]/gmu)) {
    const spec = match[1]
    if (spec.startsWith('node:')) continue
    if (!spec.startsWith('.')) { fail(`${file}: imports "${spec}"; the Host half must not depend on other packages`); continue }
    const target = relative(root, resolve(root, dirname(file), spec))
    if (!shipped.has(target)) fail(`${file}: imports ${spec}, which is not shipped`)
  }
}
const client = read('client.js')
if (/^\s*import\s/mu.test(client)) fail('client.js: must not use import statements (loaded by the module loader)')
for (const match of client.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/gu)) {
  if (match[1] !== 'react') fail(`client.js: requires "${match[1]}"; only react is provided`)
}

// 样式令牌
const ALLOWED_VARS = [/^--dsw-alias-/u, /^--dsw-specific-menu$/u, /^--dsw-elevation-/u, /^--dsw-radius-/u, /^--dsw-menu-backdrop-filter$/u, /^--dsh-composer-/u]
for (const match of client.matchAll(/var\(\s*(--[a-z0-9-]+)/giu)) {
  if (!ALLOWED_VARS.some((pattern) => pattern.test(match[1]))) fail(`client.js: uses ${match[1]}; stick to theme tokens such as --dsw-alias-*`)
}
for (const match of client.matchAll(/(?<![\w-])#[0-9a-f]{3,8}\b(?=[;}\s,)])/giu)) fail(`client.js: hard-coded color ${match[0]}; use a theme token`)

// 显示元数据
const locales = expand('locale/*.json')
if (!locales.includes(join('locale', 'en.json'))) fail('locale/en.json is missing')
for (const file of locales) {
  const language = file.slice('locale/'.length, -'.json'.length)
  if (!/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/iu.test(language)) fail(`${file}: the file name must be a language id`)
  try {
    const meta = JSON.parse(read(file)).meta
    if (typeof meta?.title !== 'string' || meta.title === '') fail(`${file}: meta.title must be a non-empty string`)
    if (typeof meta?.description !== 'string') fail(`${file}: meta.description must be a string`)
  } catch (error) {
    fail(`${file}: ${error.message}`)
  }
}
const icon = typeof pkg.icon === 'string' ? pkg.icon.replace(/^\.\//u, '') : undefined
if (icon === undefined) fail('package.json has no "icon"')
else if (!existsSync(join(root, icon))) fail(`icon ${icon} does not exist`)
else {
  if (!['.svg', '.png', '.jpg', '.jpeg', '.webp'].includes(extname(icon).toLowerCase())) fail(`icon ${icon} must be SVG, PNG, JPEG or WebP`)
  if (statSync(join(root, icon)).size > 256 * 1024) fail(`icon ${icon} is larger than 256 KiB`)
  if (!shipped.has(icon)) fail(`icon ${icon} is not listed in files`)
}

// 发布信息：市场靠 repository 把 npm 包和仓库关联起来
if (pkg.repository === undefined) fail('package.json has no "repository"')
if (typeof pkg.engines?.dsh !== 'string' || pkg.engines.dsh.trim() === '') fail('engines.dsh should state the DSH versions the plugin supports')

// 截图（只给市场和 GitHub 用，不进 npm 包）：1-8 张仓库内的位图
const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.webp']
if (existsSync(join(root, 'screenshots.json'))) {
  let shots
  try {
    shots = JSON.parse(read('screenshots.json'))
  } catch (error) {
    fail(`screenshots.json: ${error.message}`)
  }
  const list = Array.isArray(shots) ? shots : shots?.screenshots
  if (!Array.isArray(list) || list.length < 1 || list.length > 8) fail('screenshots.json must list 1-8 image paths')
  else {
    for (const shot of list) {
      if (typeof shot !== 'string' || shot.startsWith('/') || shot.split('/').includes('..')) fail(`screenshots.json: ${JSON.stringify(shot)} must be a relative path inside the repository`)
      else if (!existsSync(join(root, shot))) fail(`screenshots.json: ${shot} does not exist`)
      else if (!IMAGE_EXTS.includes(extname(shot).toLowerCase())) fail(`screenshots.json: ${shot} must be PNG, JPEG or WebP`)
    }
  }
}
for (const readme of ['README.md', 'README.zh.md']) {
  if (!existsSync(join(root, readme))) continue
  for (const match of read(readme).matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/gu)) {
    if (!/^https?:/u.test(match[1]) && !existsSync(join(root, match[1]))) fail(`${readme}: image ${match[1]} does not exist`)
  }
}

if (problems.length > 0) {
  console.error(`✗ ${problems.length} problem(s):\n${problems.map((line) => `  - ${line}`).join('\n')}`)
  process.exit(1)
}
console.log(`✓ ${pkg.name}@${pkg.version}: ${shipped.size} files, ${jsFiles.length} scripts, ${locales.length} locales — ready to pack`)
