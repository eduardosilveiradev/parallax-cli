
"use client"

import * as React from "react"
import { Send, User, Bot, Loader2, Paperclip, Plus } from "lucide-react"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"

export function ChatPanel() {
  const [messages, setMessages] = React.useState([
    {
      role: "assistant",
      content: "Hello! I'm your Parallax agent. How can I help you today?",
    },
    {
      role: "user",
      content: "I'd like to build a new feature. Can you help me?",
    },
    {
      role: "assistant",
      content: "Of course! What feature would you like to build? I can help you with code changes, debugging, and explaining how things work.",
    },
  ])

  return (
    <div className="flex h-full flex-col bg-muted/30">
      <div className="flex h-12 items-center justify-between border-b bg-background px-4 shrink-0">
        <div className="flex items-center gap-2">
          <Bot className="h-5 w-5 text-primary" />
          <span className="text-sm font-semibold">Parallax Agent</span>
          <Badge variant="outline" className="text-[10px] uppercase font-bold text-primary">Beta</Badge>
        </div>
        <Button variant="ghost" size="icon" className="h-8 w-8">
          <Plus className="h-4 w-4" />
        </Button>
      </div>
      <ScrollArea className="flex-1 p-4">
        <div className="space-y-6 max-w-2xl mx-auto">
          {messages.map((message, i) => (
            <div
              key={i}
              className={`flex gap-3 ${
                message.role === "assistant" ? "flex-row" : "flex-row-reverse"
              }`}
            >
              <Avatar className={`h-8 w-8 border ${message.role === "assistant" ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`}>
                <AvatarFallback className="text-[10px] font-bold">
                  {message.role === "assistant" ? "AI" : "ME"}
                </AvatarFallback>
              </Avatar>
              <div className={`flex flex-col gap-1.5 max-w-[80%] ${message.role === "user" ? "items-end" : "items-start"}`}>
                <div
                  className={`rounded-2xl px-4 py-2.5 text-sm shadow-sm ${
                    message.role === "assistant"
                      ? "bg-background border text-foreground"
                      : "bg-primary text-primary-foreground font-medium"
                  }`}
                >
                  {message.content}
                </div>
                <span className="text-[10px] text-muted-foreground uppercase font-medium px-1">
                  {message.role === "assistant" ? "Agent" : "You"} • 12:45 PM
                </span>
              </div>
            </div>
          ))}
        </div>
      </ScrollArea>
      <div className="p-4 border-t bg-background shrink-0">
        <div className="relative flex items-end gap-2 max-w-3xl mx-auto">
          <div className="absolute left-3 bottom-3 flex gap-2">
            <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground">
              <Paperclip className="h-4 w-4" />
            </Button>
          </div>
          <textarea
            className="flex min-h-[44px] w-full rounded-2xl border border-input bg-muted/50 px-12 py-3 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 resize-none"
            placeholder="Type a message..."
            rows={1}
          />
          <div className="absolute right-2 bottom-2">
            <Button size="icon" className="h-8 w-8 rounded-full">
              <Send className="h-4 w-4" />
            </Button>
          </div>
        </div>
        <p className="mt-2 text-center text-[10px] text-muted-foreground uppercase tracking-widest font-medium">
          Powered by Parallax AI
        </p>
      </div>
    </div>
  )
}
