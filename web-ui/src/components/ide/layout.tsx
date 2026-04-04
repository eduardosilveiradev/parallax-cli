
"use client"

import * as React from "react"
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable"
import { FileExplorer } from "./file-explorer"
import { EditorArea } from "./editor-area"
import { ChatPanel } from "./chat-panel"
import { TerminalPanel } from "./terminal-panel"

export function IDE() {
  return (
    <div className="flex h-screen w-full flex-col bg-background text-foreground">
      <header className="flex h-12 items-center border-b px-4 shrink-0 justify-between">
        <div className="flex items-center gap-2 font-semibold">
          <div className="h-6 w-6 rounded bg-primary flex items-center justify-center text-primary-foreground">
            P
          </div>
          <span>Parallax IDE</span>
        </div>
        <div className="flex items-center gap-4 text-xs font-medium text-muted-foreground uppercase tracking-widest">
          <span>v0.1.0-alpha</span>
        </div>
      </header>
      <main className="flex-1 overflow-hidden">
        <ResizablePanelGroup direction="horizontal">
          <ResizablePanel defaultSize={20} minSize={15}>
            <FileExplorer />
          </ResizablePanel>
          <ResizableHandle />
          <ResizablePanel defaultSize={50} minSize={30}>
            <ResizablePanelGroup direction="vertical">
              <ResizablePanel defaultSize={70} minSize={20}>
                <EditorArea />
              </ResizablePanel>
              <ResizableHandle />
              <ResizablePanel defaultSize={30} minSize={10}>
                <TerminalPanel />
              </ResizablePanel>
            </ResizablePanelGroup>
          </ResizablePanel>
          <ResizableHandle />
          <ResizablePanel defaultSize={30} minSize={20}>
            <ChatPanel />
          </ResizablePanel>
        </ResizablePanelGroup>
      </main>
      <footer className="h-6 border-t bg-muted/50 flex items-center px-4 text-[10px] text-muted-foreground uppercase tracking-wider">
        Ready
      </footer>
    </div>
  )
}
