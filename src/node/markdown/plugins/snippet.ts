import fs from 'fs-extra'
import path from 'path'
import type MarkdownIt from 'markdown-it'
import type { RuleBlock } from 'markdown-it/lib/parser_block'
import type { MarkdownEnv } from '../env'

export function dedent(text: string): string {
  const lines = text.split('\n')

  const minIndentLength = lines.reduce((acc, line) => {
    for (let i = 0; i < line.length; i++) {
      if (line[i] !== ' ' && line[i] !== '\t') return Math.min(i, acc)
    }
    return acc
  }, Infinity)

  if (minIndentLength < Infinity) {
    return lines.map((x) => x.slice(minIndentLength)).join('\n')
  }

  return text
}

function testLine(
  line: string,
  regexp: RegExp,
  regionName: string,
  end: boolean = false
) {
  const [full, tag, name] = regexp.exec(line.trim()) || []

  return (
    full &&
    tag &&
    name === regionName &&
    tag.match(end ? /^[Ee]nd ?[rR]egion$/ : /^[rR]egion$/)
  )
}

function findRegion(lines: Array<string>, regionName: string) {
  const regionRegexps = [
    /^\/\/ ?#?((?:end)?region) ([\w*-]+)$/, // javascript, typescript, java
    /^\/\* ?#((?:end)?region) ([\w*-]+) ?\*\/$/, // css, less, scss
    /^#pragma ((?:end)?region) ([\w*-]+)$/, // C, C++
    /^<!-- #?((?:end)?region) ([\w*-]+) -->$/, // HTML, markdown
    /^#((?:End )Region) ([\w*-]+)$/, // Visual Basic
    /^::#((?:end)region) ([\w*-]+)$/, // Bat
    /^# ?((?:end)?region) ([\w*-]+)$/ // C#, PHP, Powershell, Python, perl & misc
  ]

  let regexp = null
  let start = -1

  for (const [lineId, line] of lines.entries()) {
    if (regexp === null) {
      for (const reg of regionRegexps) {
        if (testLine(line, reg, regionName)) {
          start = lineId + 1
          regexp = reg
          break
        }
      }
    } else if (testLine(line, regexp, regionName, true)) {
      return { start, end: lineId, regexp }
    }
  }

  return null
}

export const snippetPlugin = (md: MarkdownIt, srcDir: string) => {
  const parser: RuleBlock = (state, startLine, endLine, silent) => {
    const CH = '<'.charCodeAt(0)
    const pos = state.bMarks[startLine] + state.tShift[startLine]
    const max = state.eMarks[startLine]

    // if it's indented more than 3 spaces, it should be a code block
    if (state.sCount[startLine] - state.blkIndent >= 4) {
      return false
    }

    for (let i = 0; i < 3; ++i) {
      const ch = state.src.charCodeAt(pos + i)
      if (ch !== CH || pos + i >= max) return false
    }

    if (silent) {
      return true
    }

    const start = pos + 3
    const end = state.skipSpacesBack(max, pos)

    /**
     * raw path format: "/path/to/file.extension#region {meta}"
     *    where #region and {meta} are optional
     *    and meta can be like '1,2,4-6 lang', 'lang' or '1,2,4-6'
     *
     * captures: ['/path/to/file.extension', 'extension', '#region', '{meta}', '[title]']
     */
    const rawPathRegexp =
      /^(.+(?:\.([a-z0-9]+)))(?:(#[\w-]+))?(?: ?(?:{(\d+(?:[,-]\d+)*)? ?(\S+)?}))? ?(?:\[(.+)\])?$/

    const rawPath = state.src
      .slice(start, end)
      .trim()
      .replace(/^@/, srcDir)
      .trim()

    const [
      filepath = '',
      extension = '',
      region = '',
      lines = '',
      lang = '',
      rawTitle = ''
    ] = (rawPathRegexp.exec(rawPath) || []).slice(1)

    const title = rawTitle || filepath.split('/').pop() || ''

    state.line = startLine + 1

    const token = state.push('fence', 'code', 0)
    token.info = `${lang || extension}${lines ? `{${lines}}` : ''}${
      title ? `[${title}]` : ''
    }`

    const resolvedPath = path.resolve(
      path.dirname((state.env as MarkdownEnv).path),
      filepath
    )
    // @ts-ignore
    token.src = [resolvedPath, region.slice(1)]
    token.markup = '```'
    token.map = [startLine, startLine + 1]

    return true
  }

  const fence = md.renderer.rules.fence!

  md.renderer.rules.fence = (...args) => {
    const [tokens, idx, , { loader }] = args
    const token = tokens[idx]
    // @ts-ignore
    const [src, regionName] = token.src ?? []

    if (src) {
      if (loader) {
        loader.addDependency(src)
      }
      const isAFile = fs.lstatSync(src).isFile()
      if (fs.existsSync(src) && isAFile) {
        let content = fs.readFileSync(src, 'utf8')

        if (regionName) {
          const lines = content.split(/\r?\n/)
          const region = findRegion(lines, regionName)

          if (region) {
            content = dedent(
              lines
                .slice(region.start, region.end)
                .filter((line: string) => !region.regexp.test(line.trim()))
                .join('\n')
            )
          }
        }

        token.content = content
      } else {
        token.content = isAFile
          ? `Code snippet path not found: ${src}`
          : `Invalid code snippet option`
        token.info = ''
      }
    }
    return fence(...args)
  }

  md.block.ruler.before('fence', 'snippet', parser)
}
