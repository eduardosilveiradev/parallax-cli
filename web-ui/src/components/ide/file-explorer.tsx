
"use client"

import * as React from "react"
import { ChevronRight, ChevronDown, File, Folder, Search } from "lucide-react"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"

export function FileExplorer() {
  return (
    <div className="flex h-full flex-col border-r">
      <div className="p-4 flex flex-col gap-4 border-b">
        <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Explorer
        </div>
        <div className="relative">
          <Search className="absolute left-2 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
          <Input placeholder="Search files..." className="pl-7 h-8 text-xs" />
        </div>
      </div>
      <ScrollArea className="flex-1">
        <div className="p-2 space-y-1">
          <FolderItem name="src" isOpen={true}>
            <FolderItem name="components" isOpen={true}>
              <FileItem name="layout.tsx" isActive={true} />
              <FileItem name="editor.tsx" />
              <FileItem name="sidebar.tsx" />
            </FolderItem>
            <FolderItem name="lib">
              <FileItem name="utils.ts" />
            </FolderItem>
            <FileItem name="app/page.tsx" />
          </FolderItem>
          <FileItem name="package.json" />
          <FileItem name="tsconfig.json" />
        </div>
      </ScrollArea>
    </div>
  )
}

function FolderItem({ name, children, isOpen: initialOpen = false }: { name: string; children?: React.ReactNode; isOpen?: boolean }) {
  const [isOpen, setIsOpen] = React.useState(initialOpen)

  return (
    <div>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-xs hover:bg-muted/50 transition-colors"
      >
        {isOpen ? (
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
        )}
        <Folder className="h-3.5 w-3.5 text-blue-400 fill-blue-400/20" />
        <span>{name}</span>
      </button>
      {isOpen && <div className="ml-4 mt-0.5 space-y-0.5 border-l pl-2">{children}</div>}
    </div>
  )
}

function FileItem({ name, isActive = false }: { name: string; isActive?: boolean }) {
  return (
    <button
      className={cn(
        "flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-xs transition-colors",
        isActive ? "bg-primary/10 text-primary font-medium" : "hover:bg-muted/50"
      )}
    >
      <File className="h-3.5 w-3.5 text-muted-foreground" />
      <span>{name}</span>
    </button>
  )
}
