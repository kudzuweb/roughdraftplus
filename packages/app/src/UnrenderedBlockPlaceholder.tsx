import { type NodeViewProps, NodeViewWrapper } from "@tiptap/react";
import { TriangleAlert } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import type { RawMarkdownBlockType } from "./markdown";

/**
 * Spec key the editor's guard plugin puts on a node decoration when it has
 * just refused a keystroke that would have deleted this block. It lives here
 * so the extension can import it without the placeholder importing back.
 *
 * The note says only what stays true once the refusal has run. The guard
 * releases the caret clear of the block, so the reader can type straight on and
 * a sentence telling them their typing will not land would be false by the time
 * they read it.
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
  selected,
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
      // A click has to reach ProseMirror before the keystroke that follows it,
      // and nothing else on this element says whether it has. The selected
      // class goes on the react-renderer wrapper above, out of reach of a
      // test id.
      data-selected={selected ? "true" : undefined}
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
            delete a selection that includes it. Switch to code view to remove
            its Markdown.
          </AlertDescription>
        ) : null}
      </Alert>
    </NodeViewWrapper>
  );
}
