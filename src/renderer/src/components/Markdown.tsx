import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

interface MarkdownProps {
  children: string
  compact?: boolean
}

export function Markdown({ children, compact }: MarkdownProps): React.JSX.Element {
  return (
    <div className={compact ? 'markdown markdown--compact' : 'markdown'}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children: label }) => (
            <a
              href={href || '#'}
              onClick={(event) => {
                event.preventDefault()
                if (href && /^https?:/i.test(href)) void window.proharness.shell.openExternal(href)
              }}
            >
              {label}
            </a>
          ),
          pre: ({ children: code }) => <pre className="code-block">{code}</pre>,
          code: ({ className, children: code }) => {
            const isBlock = Boolean(className?.startsWith('language-'))
            if (isBlock) {
              return (
                <code className={className} data-language={className?.replace('language-', '')}>
                  {code}
                </code>
              )
            }
            return <code className="inline-code">{code}</code>
          },
          input: ({ checked, type }) =>
            type === 'checkbox' ? (
              <input className="task-check" type="checkbox" checked={checked} readOnly tabIndex={-1} />
            ) : null,
          table: ({ children: rows }) => (
            <div className="table-wrap">
              <table>{rows}</table>
            </div>
          )
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  )
}
