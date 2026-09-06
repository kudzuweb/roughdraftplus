import { type NodeViewProps, NodeViewWrapper } from "@tiptap/react";
import { TriangleAlert } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import type { RawMarkdownBlockType } from "./markdown";

const blockLabels: Record<RawMarkdownBlockType, string> = {
  table: "Table",
  details: "Details block",
  "html-comment": "HTML comment",
  "indented-code": "Indented code block",
};

function isRawMarkdownBlockType(value: unknown): value is RawMarkdownBlockType {
  return typeof value === "string" && value in blockLabels;
}

export function UnrenderedBlockPlaceholder({ node }: NodeViewProps) {
  const blockType = isRawMarkdownBlockType(node.attrs.blockType)
    ? node.attrs.blockType
    : "block";
  const label = isRawMarkdownBlockType(blockType)
    ? blockLabels[blockType]
    : "Block";

  return (
    <NodeViewWrapper
      data-testid="unrendered-block-placeholder"
      data-block-type={blockType}
      contentEditable={false}
      className="my-4"
    >
      <Alert role="note">
        <TriangleAlert aria-hidden="true" />
        <AlertTitle>{label} not rendered</AlertTitle>
        <AlertDescription>
          Roughdraft could not render this {label.toLowerCase()} in rich text.
          Its Markdown is kept exactly as written; open the code editor to read
          or edit it.
        </AlertDescription>
      </Alert>
    </NodeViewWrapper>
  );
}
