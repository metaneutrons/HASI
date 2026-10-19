import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import styles from "./chat-markdown.module.css";

function validatedHttpUrl(value: string): string | undefined {
  if (!/^https?:\/\//iu.test(value) || /[\s\u0000-\u001f\u007f]/u.test(value)) return undefined;

  try {
    const url = new URL(value);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

const components: Components = {
  a({ children, href }) {
    return href
      ? <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>
      : <span>{children}</span>;
  },
  img: () => null,
  table({ children }) {
    return <div className={styles.tableWrap} tabIndex={0} role="region" aria-label="Markdown-Tabelle, horizontal scrollbar"><table>{children}</table></div>;
  },
};

/** Render Markdown as safe, local chat content. The original source remains the caller's data. */
export function ChatMarkdown({ source }: { source: string }) {
  return <div className={styles.markdown}>
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={components} skipHtml urlTransform={validatedHttpUrl}>
      {source}
    </ReactMarkdown>
  </div>;
}
