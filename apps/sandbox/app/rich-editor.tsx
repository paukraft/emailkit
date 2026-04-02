"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  RiBold,
  RiCodeLine,
  RiH1,
  RiH2,
  RiItalic,
  RiLinkM,
  RiLinkUnlinkM,
  RiListOrdered,
  RiListUnordered,
  RiStrikethrough,
  RiUnderline,
} from "@remixicon/react";
import { $generateHtmlFromNodes, $generateNodesFromDOM } from "@lexical/html";
import { AutoLinkNode, LinkNode, TOGGLE_LINK_COMMAND } from "@lexical/link";
import {
  INSERT_ORDERED_LIST_COMMAND,
  INSERT_UNORDERED_LIST_COMMAND,
  ListItemNode,
  ListNode,
  REMOVE_LIST_COMMAND,
  $isListNode,
} from "@lexical/list";
import { $setBlocksType } from "@lexical/selection";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { LinkPlugin } from "@lexical/react/LexicalLinkPlugin";
import { ListPlugin } from "@lexical/react/LexicalListPlugin";
import { OnChangePlugin } from "@lexical/react/LexicalOnChangePlugin";
import { RichTextPlugin } from "@lexical/react/LexicalRichTextPlugin";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { CodeHighlightNode, CodeNode } from "@lexical/code";
import { $createHeadingNode, $isHeadingNode, HeadingNode, QuoteNode } from "@lexical/rich-text";
import { $findMatchingParent } from "@lexical/utils";
import {
  $createParagraphNode,
  $getRoot,
  $getSelection,
  $isElementNode,
  $isRangeSelection,
  $isRootOrShadowRoot,
  COMMAND_PRIORITY_LOW,
  FORMAT_TEXT_COMMAND,
  SELECTION_CHANGE_COMMAND,
  type EditorState,
  type LexicalEditor,
  type LexicalNode,
} from "lexical";
import { cn } from "@/lib/cn";

type ToolbarState = {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strikethrough: boolean;
  code: boolean;
  block: "paragraph" | "h1" | "h2";
  list: "bullet" | "number" | null;
  link: boolean;
};

const editorTheme = {
  heading: {
    h1: "text-base font-bold my-1",
    h2: "text-sm font-semibold my-1",
  },
  list: {
    ol: "list-decimal pl-4",
    ul: "list-disc pl-4",
    listitem: "my-0.5",
    nested: {
      listitem: "my-0.5",
    },
  },
  link: "text-blue-400 underline",
  text: {
    bold: "font-semibold",
    italic: "italic",
    underline: "underline",
    strikethrough: "line-through",
    code: "rounded bg-secondary px-1 py-0.5 font-mono text-[11px]",
  },
  code: "my-1 rounded bg-secondary px-2 py-1 font-mono text-[11px]",
};

const EMPTY_HTML_MARKERS = new Set(["", "<p><br></p>", "<p></p>"]);

function normalizeHtml(html: string) {
  return html.replace(/\u200b/g, "").trim();
}

function sanitizeOutgoingHtml(html: string) {
  const normalized = normalizeHtml(html);
  if (EMPTY_HTML_MARKERS.has(normalized)) return "";

  return normalized
    .replace(/\sclass="[^"]*"/g, "")
    .replace(/\sdir="[^"]*"/g, "");
}

function getSelectedNode(selection: ReturnType<typeof $getSelection>) {
  if (!$isRangeSelection(selection)) return null;
  const anchor = selection.anchor.getNode();
  const focus = selection.focus.getNode();
  return anchor === focus
    ? anchor
    : selection.isBackward()
      ? focus
      : anchor;
}

function getTopLevelBlock(node: LexicalNode | null) {
  if (!node) return null;
  return $findMatchingParent(node, (candidate) => {
    const parent = candidate.getParent();
    return $isElementNode(candidate) && parent !== null && $isRootOrShadowRoot(parent);
  });
}

function readToolbarState(editor: LexicalEditor): ToolbarState {
  return editor.getEditorState().read(() => {
    const selection = $getSelection();
    const next: ToolbarState = {
      bold: false,
      italic: false,
      underline: false,
      strikethrough: false,
      code: false,
      block: "paragraph",
      list: null,
      link: false,
    };

    if (!$isRangeSelection(selection)) return next;

    next.bold = selection.hasFormat("bold");
    next.italic = selection.hasFormat("italic");
    next.underline = selection.hasFormat("underline");
    next.strikethrough = selection.hasFormat("strikethrough");
    next.code = selection.hasFormat("code");

    const selectedNode = getSelectedNode(selection);
    if (!selectedNode) return next;

    const topLevel = getTopLevelBlock(selectedNode);

    if (topLevel && $isHeadingNode(topLevel)) {
      const tag = topLevel.getTag();
      if (tag === "h1" || tag === "h2") next.block = tag;
    }

    const listNode = $findMatchingParent(selectedNode, (candidate) => {
      return $isElementNode(candidate) && candidate.getType() === "list";
    });

    if (listNode && $isListNode(listNode)) {
      const listType = listNode.getListType();
      next.list = listType === "number" ? "number" : "bullet";
    }

    next.link = selection
      .getNodes()
      .some((node) => node.getParent()?.getType() === "link" || node.getType() === "link");

    return next;
  });
}

function setEditorHtml(editor: LexicalEditor, html: string) {
  editor.update(() => {
    const root = $getRoot();
    root.clear();

    const normalized = sanitizeOutgoingHtml(html);
    if (!normalized || typeof window === "undefined") {
      root.append($createParagraphNode());
      return;
    }

    const parser = new DOMParser();
    const dom = parser.parseFromString(normalized, "text/html");
    const nodes = $generateNodesFromDOM(editor, dom);

    if (nodes.length === 0) {
      root.append($createParagraphNode());
      return;
    }

    root.append(...nodes);
  });
}

function ToolbarButton({
  icon: Icon,
  title,
  active,
  disabled,
  onClick,
}: {
  icon: typeof RiBold;
  title: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onMouseDown={(event) => {
        event.preventDefault();
        if (!disabled) onClick();
      }}
      className={cn(
        "inline-flex size-6 items-center justify-center rounded transition-colors",
        active
          ? "bg-secondary text-foreground"
          : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground",
        disabled && "pointer-events-none opacity-40",
      )}
    >
      <Icon className="size-3" />
    </button>
  );
}

function ToolbarPlugin() {
  const [editor] = useLexicalComposerContext();
  const [toolbar, setToolbar] = useState<ToolbarState>(() => readToolbarState(editor));

  useEffect(() => {
    const update = () => setToolbar(readToolbarState(editor));
    update();

    return editor.registerCommand(
      SELECTION_CHANGE_COMMAND,
      () => {
        update();
        return false;
      },
      COMMAND_PRIORITY_LOW,
    );
  }, [editor]);

  useEffect(() => {
    return editor.registerUpdateListener(() => {
      setToolbar(readToolbarState(editor));
    });
  }, [editor]);

  const setBlock = (block: ToolbarState["block"]) => {
    editor.update(() => {
      const selection = $getSelection();
      if (!$isRangeSelection(selection)) return;

      if (block === "paragraph") {
        $setBlocksType(selection, () => $createParagraphNode());
        return;
      }

      $setBlocksType(selection, () => $createHeadingNode(block));
    });
  };

  const toggleList = (type: NonNullable<ToolbarState["list"]>) => {
    editor.dispatchCommand(
      toolbar.list === type
        ? REMOVE_LIST_COMMAND
        : type === "bullet"
          ? INSERT_UNORDERED_LIST_COMMAND
          : INSERT_ORDERED_LIST_COMMAND,
      undefined,
    );
  };

  const toggleLink = () => {
    if (toolbar.link) {
      editor.dispatchCommand(TOGGLE_LINK_COMMAND, null);
      return;
    }

    const url = window.prompt("URL", "https://");
    if (!url) return;

    editor.dispatchCommand(TOGGLE_LINK_COMMAND, url);
  };

  return (
    <div className="flex items-center gap-0.5 border-b px-1.5 py-1">
      <ToolbarButton
        icon={RiBold}
        title="Bold"
        active={toolbar.bold}
        onClick={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, "bold")}
      />
      <ToolbarButton
        icon={RiItalic}
        title="Italic"
        active={toolbar.italic}
        onClick={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, "italic")}
      />
      <ToolbarButton
        icon={RiUnderline}
        title="Underline"
        active={toolbar.underline}
        onClick={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, "underline")}
      />
      <ToolbarButton
        icon={RiStrikethrough}
        title="Strikethrough"
        active={toolbar.strikethrough}
        onClick={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, "strikethrough")}
      />
      <span className="mx-0.5 h-3 w-px bg-border" />
      <ToolbarButton
        icon={RiH1}
        title="Heading 1"
        active={toolbar.block === "h1"}
        onClick={() => setBlock(toolbar.block === "h1" ? "paragraph" : "h1")}
      />
      <ToolbarButton
        icon={RiH2}
        title="Heading 2"
        active={toolbar.block === "h2"}
        onClick={() => setBlock(toolbar.block === "h2" ? "paragraph" : "h2")}
      />
      <ToolbarButton
        icon={RiCodeLine}
        title="Code"
        active={toolbar.code}
        onClick={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, "code")}
      />
      <span className="mx-0.5 h-3 w-px bg-border" />
      <ToolbarButton
        icon={RiListUnordered}
        title="Bullet list"
        active={toolbar.list === "bullet"}
        onClick={() => toggleList("bullet")}
      />
      <ToolbarButton
        icon={RiListOrdered}
        title="Numbered list"
        active={toolbar.list === "number"}
        onClick={() => toggleList("number")}
      />
      <span className="mx-0.5 h-3 w-px bg-border" />
      <ToolbarButton
        icon={RiLinkM}
        title="Insert link"
        active={toolbar.link}
        onClick={toggleLink}
      />
      <ToolbarButton
        icon={RiLinkUnlinkM}
        title="Remove link"
        disabled={!toolbar.link}
        onClick={() => editor.dispatchCommand(TOGGLE_LINK_COMMAND, null)}
      />
    </div>
  );
}

function HtmlSyncPlugin({
  value,
  onChange,
}: {
  value: string;
  onChange: (html: string) => void;
}) {
  const [editor] = useLexicalComposerContext();
  const lastValueRef = useRef(sanitizeOutgoingHtml(value));

  useEffect(() => {
    const normalized = sanitizeOutgoingHtml(value);
    if (normalized === lastValueRef.current) return;

    lastValueRef.current = normalized;
    setEditorHtml(editor, normalized);
  }, [editor, value]);

  const handleChange = (editorState: EditorState, currentEditor: LexicalEditor) => {
    editorState.read(() => {
      const html = sanitizeOutgoingHtml($generateHtmlFromNodes(currentEditor, null));
      lastValueRef.current = html;
      onChange(html);
    });
  };

  return <OnChangePlugin onChange={handleChange} />;
}

export function RichEditor({
  value,
  onChange,
}: {
  value: string;
  onChange: (html: string) => void;
}) {
  const initialConfig = useMemo(
    () => ({
      namespace: "emailkit-sandbox-editor",
      theme: editorTheme,
      nodes: [
        HeadingNode,
        QuoteNode,
        ListNode,
        ListItemNode,
        LinkNode,
        AutoLinkNode,
        CodeNode,
        CodeHighlightNode,
      ],
      onError(error: Error) {
        throw error;
      },
    }),
    [],
  );

  return (
    <div className="flex flex-col rounded-md border transition-colors focus-within:border-ring focus-within:ring-1 focus-within:ring-ring/30">
      <LexicalComposer initialConfig={initialConfig}>
        <ToolbarPlugin />
        <div className="relative min-h-[120px]">
          <RichTextPlugin
            contentEditable={
              <ContentEditable
                aria-placeholder="Write your message..."
                placeholder={<></>}
                className="min-h-[120px] max-h-[300px] overflow-y-auto scrollbar-thin px-2.5 py-2 text-xs leading-relaxed text-foreground outline-none"
              />
            }
            placeholder={
              <div className="pointer-events-none absolute left-2.5 top-2 text-xs text-muted-foreground">
                Write your message...
              </div>
            }
            ErrorBoundary={LexicalErrorBoundary}
          />
        </div>
        <HistoryPlugin />
        <ListPlugin />
        <LinkPlugin />
        <HtmlSyncPlugin value={value} onChange={onChange} />
      </LexicalComposer>
    </div>
  );
}
