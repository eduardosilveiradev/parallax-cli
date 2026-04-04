
"use client"

import * as React from "react"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area"
import { X, Code, GitCompare } from "lucide-react"
import Editor, { DiffEditor } from "@monaco-editor/react"

export function EditorArea() {
  const [mode, setMode] = React.useState<"edit" | "diff">("edit")

  return (
    <div className="flex h-full flex-col border-r bg-background">
      <div className="flex h-12 items-center justify-between border-b px-4">
        <ScrollArea className="w-full">
          <div className="flex items-center gap-1 py-1">
            <EditorTab name="layout.tsx" isActive />
            <EditorTab name="editor.tsx" />
            <EditorTab name="sidebar.tsx" />
          </div>
          <ScrollBar orientation="horizontal" />
        </ScrollArea>
        <div className="flex items-center gap-2 border-l pl-4 ml-4">
          <button
            onClick={() => setMode("edit")}
            className={`p-1.5 rounded-md transition-colors ${mode === "edit" ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/50"}`}
          >
            <Code className="h-4 w-4" />
          </button>
          <button
            onClick={() => setMode("diff")}
            className={`p-1.5 rounded-md transition-colors ${mode === "diff" ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/50"}`}
          >
            <GitCompare className="h-4 w-4" />
          </button>
        </div>
      </div>
      <div className="flex-1 relative overflow-hidden">
        {mode === "edit" ? (
          <Editor
            theme="vs-dark"
            defaultLanguage="typescript"
            defaultValue={`// Welcome to the Parallax IDE
import React from 'react';

export default function App() {
  return (
    <div>
      <h1>Hello Parallax!</h1>
    </div>
  );
}`}
            options={{
              fontSize: 13,
              minimap: { enabled: true },
              scrollBeyondLastLine: false,
              automaticLayout: true,
              fontFamily: "var(--font-geist-mono)",
            }}
          />
        ) : (
          <DiffEditor
            theme="vs-dark"
            language="typescript"
            original={`// original content`}
            modified={`// modified content`}
            options={{
              fontSize: 13,
              minimap: { enabled: true },
              scrollBeyondLastLine: false,
              automaticLayout: true,
              fontFamily: "var(--font-geist-mono)",
            }}
          />
        )}
      </div>
    </div>
  )
}

function EditorTab({ name, isActive = false }: { name: string; isActive?: boolean }) {
  return (
    <div
      className={`group flex items-center gap-2 px-3 py-1.5 text-xs font-medium cursor-pointer rounded-t-md border-b-2 transition-colors ${
        isActive
          ? "border-primary bg-background text-foreground"
          : "border-transparent text-muted-foreground hover:bg-muted/30"
      }`}
    >
      <span>{name}</span>
      <button className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-muted/50 transition-all">
        <X className="h-3 w-3" />
      </button>
    </div>
  )
}
