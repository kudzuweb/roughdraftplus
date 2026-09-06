import { type NodeViewProps, NodeViewWrapper } from "@tiptap/react";
import { TriangleAlert } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import type { RawMarkdownBlockType } from "./markdown";

/**
 * Spec key the editor's guard plugin puts on a node decoration when it has
 * just refused a keystroke that would have deleted this block. It lives here
 * so the extension can import it without the placeholder importing back.
 *
 * The note this raises claims that typing will not land either, which holds
 * while it is on screen: only a refusal sets it, every refusal answers a
 * gesture acting on a selection that includes the block, and the guard clears
 * it on the next transaction that moves the selection or changes the document.
 * So the selection still includes the block for as long as the reader can read
 * the sentence.
 */
export const rawMarkdownBlockDeletionRefusedDecoration =
  "rawMarkdownBlockDeletionRefused";

const blockLabels: Record<RawMarkdownBlockType, string> = {
  table: "Table",
  details: "Details block",
  "html-comment": "HTML comment",
  "indented-code": "Indented code block",
};

function isRawMarkdownBlockType(value: unknown): value is RawMarkdownBlockType {
  return typeof value === "string" && value in blockLabels;
}

export function UnrenderedBlockPlaceholder({
  node,
  decorations,
}: NodeViewProps) {
  const blockType = isRawMarkdownBlockType(node.attrs.blockType)
    ? node.attrs.blockType
    : "block";
  const label = isRawMarkdownBlockType(blockType)
    ? blockLabels[blockType]
    : "Block";
  const deletionRefused = decorations.some(
    (decoration) =>
      decoration.spec?.[rawMarkdownBlockDeletionRefusedDecoration] === true,
  );

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
          Its Markdown is kept exactly as written; switch to code view to read
          or edit it.
        </AlertDescription>
        {deletionRefused ? (
          <AlertDescription
            data-testid="unrendered-block-deletion-refused"
            className="font-medium text-foreground"
          >
            Rich text will not delete this {label.toLowerCase()}, and will not
            delete a selection that includes it. Nothing you type lands while it
            is selected, so click or arrow off it to carry on. Switch to code
            view to remove its Markdown.
          </AlertDescription>
        ) : null}
      </Alert>
    </NodeViewWrapper>
  );
}
