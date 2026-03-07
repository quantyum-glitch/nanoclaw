/**
 * Self-Improvement Hook for NanoClaw
 * 
 * Injects a reminder to evaluate learnings during agent bootstrap.
 * Fires on agent:bootstrap event before workspace files are injected.
 */

const REMINDER_CONTENT = `
## Self-Improvement Reminder

After completing tasks, evaluate if any learnings should be captured:

**Log when:**
- User corrects you â†’ \`.learnings/LEARNINGS.md\`
- Command/operation fails â†’ \`.learnings/ERRORS.md\`
- User wants missing capability â†’ \`.learnings/FEATURE_REQUESTS.md\`
- You discover your knowledge was wrong â†’ \`.learnings/LEARNINGS.md\`
- You find a better approach â†’ \`.learnings/LEARNINGS.md\`

**Promote when pattern is proven:**
- Behavioral patterns â†’ \`SOUL.md\`
- Workflow improvements â†’ \`AGENTS.md\`
- Tool gotchas â†’ \`TOOLS.md\`

Keep entries simple: date, title, what happened, what to do differently.
`.trim();

const handler = async (event) => {
  // Safety checks for event structure
  if (!event || typeof event !== 'object') {
    return;
  }

  // Only handle agent:bootstrap events
  if (event.type !== 'agent' || event.action !== 'bootstrap') {
    return;
  }

  // Safety check for context
  if (!event.context || typeof event.context !== 'object') {
    return;
  }

  // Inject the reminder as a virtual bootstrap file
  // Check that bootstrapFiles is an array before pushing
  if (Array.isArray(event.context.bootstrapFiles)) {
    event.context.bootstrapFiles.push({
      path: 'SELF_IMPROVEMENT_REMINDER.md',
      content: REMINDER_CONTENT,
      virtual: true,
    });
  }
};

module.exports = handler;
module.exports.default = handler;

