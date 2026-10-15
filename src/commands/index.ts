/**
 * Every command the app has, declared once.
 *
 * The menus, the keyboard shortcuts, the Ctrl+K palette and the shortcuts
 * list are all built from this registry, so a command added here is in all
 * four at once, and a shortcut can't be shown in one place and missing from
 * another. Commands never reach into React or the document store: they act
 * on a CommandContext the app hands them, which is also what lets
 * check-commands load the whole registry in Node and run every command.
 *
 * Labels follow the usual desktop rule: a command that opens a dialog or
 * asks for more ends in an ellipsis; one that acts at once doesn't.
 */
export * from './context'
export * from './predicates'
export * from './registry'
export * from './menus'
export * from './shortcuts'
