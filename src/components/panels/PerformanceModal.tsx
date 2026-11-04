import { For, Show, createSignal } from 'solid-js';
import { Button, CopyButton, Dialog, DialogActions, Notice, Table, Td, Th, Tr } from '@wired-square/kit';
import { errorMessage } from '../../lib/errors';
import { perfText } from '../../lib/perfText';
import { perf, type PerfReport } from '../../platform/perf';
import { closeDialog } from '../../store/dialogStore';

const ms = (n: number) => n.toFixed(1);

export function PerformanceModal() {
  const [report, setReport] = createSignal<PerfReport | null>(null);
  const [failure, setFailure] = createSignal<string | null>(null);
  const close = () => closeDialog('performance');
  const load = (ask: () => Promise<PerfReport>) => {
    setFailure(null);
    ask().then(setReport, (err) => setFailure(errorMessage(err)));
  };
  const refresh = () => load(perf.report);
  refresh();

  return (
    <Dialog title="Performance" wide onClose={close}>
      <p class="hint">
        How long each step has taken since launch or the last reset, in milliseconds, slowest first. p50 and p95
        cover each step’s last 256 calls. Nothing leaves this Mac.
      </p>
      <Notice tone="bad">{failure()}</Notice>
      <Show when={report()}>
        {(r) => (
          <>
            <div class="app-actions">
              <Button onClick={refresh}>Refresh</Button>
              <Button onClick={() => load(() => perf.reset().then(perf.report))}>Reset</Button>
              <CopyButton value={perfText(r())}>Copy as text</CopyButton>
            </div>
            <Show when={r().ops.length} fallback={<p class="hint">Nothing timed yet.</p>}>
              <Table
                head={
                  <>
                    <Th>Operation</Th>
                    <Th right>Calls</Th>
                    <Th right>p50</Th>
                    <Th right>p95</Th>
                    <Th right>Max</Th>
                    <Th right>Last</Th>
                  </>
                }
              >
                <For each={r().ops}>
                  {(op) => (
                    <Tr>
                      <Td strong>{op.name}</Td>
                      <Td right numeric>{op.count}</Td>
                      <Td right numeric>{ms(op.p50Ms)}</Td>
                      <Td right numeric>{ms(op.p95Ms)}</Td>
                      <Td right numeric>{ms(op.maxMs)}</Td>
                      <Td right numeric>{ms(op.lastMs)}</Td>
                    </Tr>
                  )}
                </For>
              </Table>
              <h3 class="panel-heading">Slowest calls</h3>
              <Table
                head={
                  <>
                    <Th>When</Th>
                    <Th>Operation</Th>
                    <Th right>ms</Th>
                    <Th right>Rows in</Th>
                    <Th right>Rows out</Th>
                    <Th right>Bytes</Th>
                  </>
                }
              >
                <For each={r().slowest}>
                  {(call) => (
                    <Tr>
                      <Td muted numeric>{new Date(call.at).toLocaleTimeString()}</Td>
                      <Td strong>{call.name}</Td>
                      <Td right numeric>{ms(call.ms)}</Td>
                      <Td right numeric>{call.rowsIn}</Td>
                      <Td right numeric>{call.rowsOut}</Td>
                      <Td right numeric>{call.bytes}</Td>
                    </Tr>
                  )}
                </For>
              </Table>
            </Show>
          </>
        )}
      </Show>
      <DialogActions onCancel={close} />
    </Dialog>
  );
}
