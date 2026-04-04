
"use client"

import * as React from "react"
import { Terminal, X, ChevronRight, Square, Play } from "lucide-react"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"

export function TerminalPanel() {
  const [logs, setLogs] = React.useState([
    { type: "info", text: "Starting Parallax CLI server..." },
    { type: "success", text: "Server listening on port 3000" },
    { type: "info", text: "Loading plugins..." },
    { type: "warn", text: "Plugin '@parallax/git' took longer than 500ms to load" },
    { type: "info", text: "Connected to agent..." },
    { type: "output", text: "> node build/index.js" },
    { type: "output", text: "> Running build process..." },
  ])

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="flex h-10 items-center justify-between border-b px-4 shrink-0">
        <Tabs defaultValue="terminal" className="w-full">
          <TabsList className="h-8 bg-transparent p-0">
            <TabsTrigger value="terminal" className="h-8 rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent px-3 text-xs">
              Terminal
            </TabsTrigger>
            <TabsTrigger value="output" className="h-8 rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent px-3 text-xs">
              Output
            </TabsTrigger>
            <TabsTrigger value="debug" className="h-8 rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent px-3 text-xs">
              Debug Console
            </TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="flex items-center gap-2">
          <button className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground">
            <Play className="h-3 w-3" />
          </button>
          <button className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground">
            <Square className="h-3 w-3 fill-current" />
          </button>
          <button className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground">
            <X className="h-3 w-3" />
          </button>
        </div>
      </div>
      <ScrollArea className="flex-1 bg-black/20 p-4 font-mono text-[11px] leading-relaxed">
        <div className="space-y-1">
          {logs.map((log, i) => (
            <div key={i} className="flex gap-2">
              <span className={`shrink-0 ${
                log.type === "info" ? "text-blue-400" :
                log.type === "success" ? "text-green-400" :
                log.type === "warn" ? "text-yellow-400" :
                "text-muted-foreground"
              }`}>
                {log.type === "output" ? <ChevronRight className="h-3 w-3 inline" /> : log.type.toUpperCase() + ":"}
              </span>
              <span className="text-zinc-300">{log.text}</span>
            </div>
          ))}
          <div className="flex items-center gap-2">
            <span className="text-green-400">$</span>
            <span className="animate-pulse w-1.5 h-3.5 bg-zinc-500" />
          </div>
        </div>
      </ScrollArea>
    </div>
  )
}
