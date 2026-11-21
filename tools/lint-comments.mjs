import fs from "node:fs"
import path from "node:path"

const root = path.resolve(process.argv[2] ?? ".")
const update = process.argv.includes("--update-baseline")
const baselinePath = path.join(root, "tools/comment-baseline.json")

const scanDirs = (() => {
  const flag = process.argv.find((a) => a.startsWith("--dirs="))
  return flag ? flag.slice("--dirs=".length).split(",") : ["."]
})()
const skipDirs = new Set(["vendor", "workspace", "docs", "tools", "node_modules", ".git"])
const allowlist = [/^\s*\/\/\s*@ts-/, /^\s*\/\/\s*eslint/, /^\s*\/\/#\s*sourceMappingURL/, /^\s*\/\*\s*(SPDX|Generated\.|!)/]

const files = []
function walk(target) {
  const full = path.join(root, target)
  if (!fs.existsSync(full)) return
  const stat = fs.statSync(full)
  if (stat.isFile()) {
    if (/\.tsx?$/.test(target)) files.push(target)
    return
  }
  for (const entry of fs.readdirSync(full, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (skipDirs.has(entry.name)) continue
      walk(path.join(target, entry.name))
    } else if (/\.tsx?$/.test(entry.name)) {
      files.push(path.join(target, entry.name))
    }
  }
}
for (const target of scanDirs) walk(target)

function findComments(text) {
  const found = []
  const lines = text.split("\n")
  let block = false
  lines.forEach((line, index) => {
    const trimmed = line.trim()
    if (allowlist.some((re) => re.test(line))) return
    if (block) {
      found.push({ line: index + 1, text: trimmed })
      if (trimmed.includes("*/")) block = false
      return
    }
    if (trimmed.startsWith("//")) found.push({ line: index + 1, text: trimmed })
    else if (trimmed.startsWith("{/*")) found.push({ line: index + 1, text: trimmed })
    else if (trimmed.startsWith("/*")) {
      found.push({ line: index + 1, text: trimmed })
      if (!trimmed.includes("*/")) block = true
    }
  })
  return found
}

const counts = {}
let total = 0
for (const file of files) {
  const found = findComments(fs.readFileSync(path.join(root, file), "utf8"))
  if (found.length === 0) continue
  counts[file] = found.length
  total += found.length
  for (const item of found) console.log(`${file}:${item.line}: ${item.text.slice(0, 90)}`)
}

if (update) {
  const sorted = Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)))
  fs.writeFileSync(baselinePath, JSON.stringify({ total, files: sorted }, null, 2) + "\n")
  console.log(`\nbaseline written: ${total} comments in ${Object.keys(sorted).length} files`)
  process.exit(0)
}

const baseline = fs.existsSync(baselinePath)
  ? JSON.parse(fs.readFileSync(baselinePath, "utf8"))
  : { total: 0, files: {} }
const regressions = []
for (const [file, count] of Object.entries(counts)) {
  const allowed = baseline.files[file] ?? 0
  if (count > allowed) regressions.push(`${file}: ${count} > ${allowed}`)
}

console.log(`\ncomments: ${total} / baseline ${baseline.total}`)
const failed = total > baseline.total || regressions.length > 0
if (failed) {
  for (const item of regressions) console.log(`regression ${item}`)
  console.error("Comment regression. Delete the comments or move the decision to docs/adr/.")
} else {
  console.log("ok")
}
process.exit(failed ? 1 : 0)