import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export function Markdown({ children }: { children: string }) {
	return (
		<div className="md-body text-sm">
			<ReactMarkdown
				remarkPlugins={[remarkGfm]}
				components={{
					a: ({ children, ...props }) => (
						<a {...props} target="_blank" rel="noopener">
							{children}
						</a>
					),
				}}
			>
				{children}
			</ReactMarkdown>
		</div>
	);
}
