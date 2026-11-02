/**
 * Pane-row probes for the terminal view: the row is explicit state on the
 * panel controller, so it can be exercised without a DOM.
 *
 * Run: node --experimental-strip-types scratch/verify-panes.ts
 */
import { MAX_PANES, PanelController } from '../src/client/panel/controller.ts'

let failed = 0

function ok(name: string, pass: boolean, detail = ''): void {
  if (pass) {
    console.log(`PASS ${name}  ${detail}`)
    return
  }
  failed += 1
  console.log(`FAIL ${name}  ${detail}`)
}

const controller = new PanelController()

// 1. Opening a tab puts it in the row and makes it active.
const first = controller.openTerminalTab('alpha')
const row = (): string => controller.getSnapshot().panes.join(',')
ok('panes: new tab joins the row', row() === first, row())
ok('panes: new tab is active', controller.getSnapshot().activeTerminalTabId === first)

// 2. A second tab shows up beside the first, not instead of it.
const second = controller.openTerminalTab('beta')
ok('panes: second tab is side by side', row() === `${first},${second}`, row())

// 3. Selecting a background tab brings it into the row.
controller.hideTerminalPane(second)
ok('panes: hide removes the pane', row() === first, row())
ok('panes: hiding does not close the tab', controller.terminalTab(second) !== undefined)
controller.setActiveTerminalTab(second)
ok('panes: selecting shows the pane again', row() === `${first},${second}`, row())

// 4. The manual control adds a connected tab that is not displayed.
controller.hideTerminalPane(first)
ok('panes: manual hide leaves one', row() === second, row())
controller.showTerminalPane(first)
ok('panes: manual show adds it back', row() === `${second},${first}`, row())

// 5. Capacity: the oldest pane gives way, never the request itself.
const extra = [0, 1, 2].map(index => controller.openTerminalTab('host-' + String(index)))
ok('panes: row stays at the cap', controller.getSnapshot().panes.length === MAX_PANES, row())
ok('panes: newest tab is in the row', row().endsWith(extra[extra.length - 1]), row())

// 6. Closing the active pane hands over to a remaining pane and drops the tab.
const closing = controller.getSnapshot().activeTerminalTabId as string
controller.closeTerminalTab(closing)
ok('panes: closed tab leaves the row', !controller.getSnapshot().panes.includes(closing), row())
ok('panes: another pane takes over', controller.getSnapshot().activeTerminalTabId !== undefined && controller.getSnapshot().panes.includes(controller.getSnapshot().activeTerminalTabId as string), String(controller.getSnapshot().activeTerminalTabId))

// 7. Hiding the active pane activates what is left instead of emptying the view.
const active = controller.getSnapshot().activeTerminalTabId as string
controller.hideTerminalPane(active)
const afterHide = controller.getSnapshot()
ok('panes: hiding the active pane keeps a target', afterHide.activeTerminalTabId === afterHide.panes[afterHide.panes.length - 1], String(afterHide.activeTerminalTabId))

// 8. A closed tab never lingers in the row, even when it was not the active one.
const spare = controller.getSnapshot().panes[0] as string
controller.closeTerminalTab(spare)
ok('panes: closing a background pane drops it', !controller.getSnapshot().panes.includes(spare), row())

console.log(failed === 0 ? 'ALL PANE PROBES PASSED' : `${failed} PANE PROBE(S) FAILED`)
if (failed > 0) process.exit(1)
