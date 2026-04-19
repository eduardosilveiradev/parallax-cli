export class ContextManager {
    public compactionCount = 0;
    public maxTokens: number;

    constructor(maxTokens: number) {
        this.maxTokens = maxTokens;
    }

    public addMessage(messages: any[], newMessage: any): any[] {
        return [...messages, newMessage];
    }

    /**
     * Highly generalized naive token estimator. 
     * ~4 characters per token for English text/JSON structure.
     */
    private estimateTokens(message: any): number {
        const str = typeof message === 'string' ? message : JSON.stringify(message);
        return Math.ceil(str.length / 4);
    }

    /**
     * Checks if we are at 90% of our maximum context window.
     */
    public shouldCompact(messages: any[]): boolean {
        let total = 0;
        for (const m of messages) {
            total += this.estimateTokens(m);
        }
        return total > this.maxTokens * 0.9;
    }

    /**
     * Drops older messages to recover ~25% of the context window.
     * Safely preserves conversation boundaries to avoid alternating role violations 
     * or orphan tool results that would crash the provider APIs.
     */
    public compact(messages: any[]): any[] {
        this.compactionCount++;
        
        // Never compact if we barely have any conversational turns
        if (messages.length <= 4) return messages;

        const reduceGoal = this.maxTokens * 0.25; 
        let droppedTokens = 0;
        let dropIndex = 0;

        for (let i = 0; i < messages.length - 2; i++) {
             droppedTokens += this.estimateTokens(messages[i]);
             dropIndex = i + 1;
             
             if (droppedTokens > reduceGoal) {
                 // Ensure the new start of the conversation is a proper 'user' turn.
                 // Also ensure it is NOT a user turn that only contains tool_results
                 // (because that would be an orphan tool result without the assistant's previous tool_call).
                 while (dropIndex < messages.length - 1) {
                     const isUser = messages[dropIndex].role === 'user';
                     const msgStr = JSON.stringify(messages[dropIndex]);
                     const isOrphanToolResult = msgStr.includes('tool_result') || msgStr.includes('functionResponse');
                     
                     if (isUser && !isOrphanToolResult) {
                         break; // We found a clean starting point
                     }
                     dropIndex++;
                 }
                 break;
             }
        }

        return messages.slice(dropIndex);
    }
}
