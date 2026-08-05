import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";

export function MarkdownContent({ content, className = "" }: { content: string; className?: string }) {
  return <div className={`markdown-content ${className}`.trim()}>
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkBreaks]}
      skipHtml
      components={{
        a: ({ children, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer">{children}</a>
      }}
    >
      {content}
    </ReactMarkdown>
  </div>;
}
