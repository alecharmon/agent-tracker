import * as React from "react"

const TOKEN = /(https?:\/\/[^\s<>"')\]]+)|\b([0-9a-f]{40})\b/g

/** Short label for a URL: GitHub PRs/issues become owner/repo#123. */
export function shortUrl(url: string) {
  const gh = url.match(/^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/(?:pull|issues)\/(\d+)/)
  if (gh) return `${gh[1]}#${gh[2]}`
  return url.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "")
}

/**
 * Status text with URLs turned into links and commit shas shortened.
 * `links={false}` keeps it plain (for text inside buttons or tooltips) but still tidies it.
 */
export function RichText({ text, links = true }: { text: string; links?: boolean }) {
  const out: React.ReactNode[] = []
  let last = 0
  for (const m of text.matchAll(TOKEN)) {
    out.push(text.slice(last, m.index))
    const [tok, url, sha] = m
    if (url)
      out.push(
        links ? (
          <a key={m.index} href={url} target="_blank" rel="noreferrer" title={url}
            className="font-medium text-blue-600 underline-offset-2 hover:underline dark:text-blue-400"
            onClick={(e) => e.stopPropagation()}>
            {shortUrl(url)}
          </a>
        ) : (
          shortUrl(url)
        ),
      )
    else
      out.push(<code key={m.index} title={sha} className="rounded bg-muted px-1 font-mono text-[0.85em]">{tok.slice(0, 7)}</code>)
    last = m.index + tok.length
  }
  out.push(text.slice(last))
  return <>{out}</>
}
