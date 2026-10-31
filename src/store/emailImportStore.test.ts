import { beforeEach, expect, it, vi } from 'vitest';
import { doc } from '../platform/document';
import { boardStore } from './boardStore';
import { emailImportStore, NEW_CLUSTER } from './emailImportStore';
import type { EmailDraft } from '../bindings/EmailDraft';
import type { Card } from '../types/board';

vi.mock('../platform/document', () => ({ doc: { edit: vi.fn() } }));
vi.mock('../storage', () => ({ storage: {} }));

const message = (title: string, messageId: string, over: Partial<EmailDraft['email']> = {}): EmailDraft => ({
  title,
  notes: '',
  occurredAt: null,
  occurredAtPrecision: 'minute',
  kind: 'email',
  email: { from: null, to: [], cc: [], messageId, inReplyTo: null, attachments: [], ...over },
  imageFile: null,
  bytes: 1,
});

const onBoard = (id: string, over: Partial<Card>) =>
  ({ id, title: id, notes: '', clusterIds: ['g1'], kind: 'email', position: { x: 0, y: 0 }, ...over }) as Card;

beforeEach(() => {
  vi.mocked(doc.edit).mockReset().mockResolvedValue();
  boardStore.setState({
    currentBoardId: 'brd_open',
    clusters: [{ id: 'g1', label: 'One', color: '#fff', visible: true }],
    cards: [
      onBoard('seen', { email: message('Seen', '<seen>').email }),
      onBoard('waiting', { email: { ...message('', '<waiting>').email, source: 'mail-drag' } }),
      onBoard('person', { kind: 'person', clusterIds: [] }),
    ],
    connections: [],
  });
});

it('an import, its new cluster, completions, memberships and offer patches go as one edit', async () => {
  emailImportStore.setState({
    drafts: [message('Re: Plan', '<new>'), message('Plan', '<seen>'), message('Plan', '<waiting>')],
    clusterId: NEW_CLUSTER,
  });
  const { addedIds } = await emailImportStore.getState().commit({
    entityDrafts: [],
    patches: [['person', { notes: 'jo@example.com' }]],
  });

  expect(doc.edit).toHaveBeenCalledOnce();
  const [boardId, edit] = vi.mocked(doc.edit).mock.calls[0];
  expect(boardId).toBe('brd_open');
  const [cluster] = edit.clusters!;
  expect(cluster.label).toBe('Plan');
  expect(edit.cards!.map((c) => [c.title, c.clusterIds])).toEqual([['Re: Plan', [cluster.id]]]);
  expect(edit.cardUpdates!.map((u) => u.id)).toEqual(['waiting', 'seen', 'person']);
  expect(edit.cardUpdates![1].patch).toEqual({ clusterIds: ['g1', cluster.id] });
  expect(addedIds).toEqual(['waiting', edit.cards![0].id]);
});

it('frames the drawn cards an import adds, though the shell has not sent them back yet', async () => {
  emailImportStore.setState({ drafts: [message('New', '<new>')], clusterId: null });
  const { addedIds, drawnIds } = await emailImportStore.getState().commit({
    entityDrafts: [{ title: 'Jo', kind: 'person' }],
    patches: [],
  });
  const person = vi.mocked(doc.edit).mock.calls[0][1].cards!.find((c) => c.kind === 'person')!;
  expect(addedIds).toHaveLength(2);
  expect(drawnIds).toEqual([person.id]);
  expect(boardStore.getState().cards.some((c) => c.id === person.id)).toBe(false);
});
