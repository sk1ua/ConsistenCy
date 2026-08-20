import React, { useState } from "react";
import { Check, Copy } from "lucide-react";
import { IconButton } from "./IconButton";

export interface CodeBlockProps {
  code: string;
  language?: string;
  fileName?: string;
  showLineNumbers?: boolean;
  startLineNumber?: number;
  maxHeight?: number | string;
  className?: string;
}

export const CodeBlock: React.FC<CodeBlockProps> = ({
  code,
  language,
  fileName,
  showLineNumbers = false,
  startLineNumber = 1,
  maxHeight,
  className = ""
}) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const lines = code.split("\n");

  return (
    <div
      className={`ds-code-block-wrapper ${className}`.trim()}
      style={{
        border: "1px solid var(--border)",
        borderRadius: "var(--ds-radius-md)",
        overflow: "hidden",
        background: "var(--surface-muted)"
      }}
    >
      {(fileName || language) && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "6px 12px",
            borderBottom: "1px solid var(--border)",
            background: "var(--surface-subtle)",
            fontSize: "12px",
            fontFamily: "var(--ds-font-mono)",
            color: "var(--muted-strong)"
          }}
        >
          <span>{fileName || language}</span>
          <IconButton
            icon={copied ? <Check size={14} color="var(--success)" /> : <Copy size={14} />}
            label="Copy Code"
            size="sm"
            onClick={handleCopy}
          />
        </div>
      )}

      <div
        className="ds-code-block"
        style={{
          maxHeight: maxHeight ?? undefined,
          overflowY: maxHeight ? "auto" : "visible",
          border: "none",
          borderRadius: 0,
          margin: 0
        }}
      >
        {!fileName && !language && (
          <div style={{ position: "absolute", top: 6, right: 6 }}>
            <IconButton
              icon={copied ? <Check size={14} color="var(--success)" /> : <Copy size={14} />}
              label="Copy Code"
              size="sm"
              onClick={handleCopy}
            />
          </div>
        )}

        {showLineNumbers ? (
          <table style={{ borderCollapse: "collapse", width: "100%", tableLayout: "auto" }}>
            <tbody>
              {lines.map((line, idx) => (
                <tr key={idx}>
                  <td
                    style={{
                      userSelect: "none",
                      color: "var(--muted)",
                      paddingRight: "12px",
                      textAlign: "right",
                      width: "1%",
                      whiteSpace: "nowrap",
                      opacity: 0.6
                    }}
                  >
                    {startLineNumber + idx}
                  </td>
                  <td style={{ whiteSpace: "pre-wrap", wordBreak: "break-all" }}>{line || " "}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <pre style={{ margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-all" }}>{code}</pre>
        )}
      </div>
    </div>
  );
};
