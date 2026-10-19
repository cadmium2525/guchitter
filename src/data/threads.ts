import type { Post } from './posts';

export interface ThreadEntry {
  id: string;
  post?: Post;
  depth: number;
}

export function indexPosts(posts: readonly Post[]) {
  const byId = new Map(posts.map(post => [post.id, post]));
  const replies = new Map<string, Post[]>();
  for (const post of posts) {
    if (!post.replyToId) continue;
    const siblings = replies.get(post.replyToId) ?? [];
    siblings.push(post);
    replies.set(post.replyToId, siblings);
  }
  for (const siblings of replies.values()) {
    siblings.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }
  return { byId, replies };
}

/** Walk ancestors and descendants iteratively, including a missing-parent stub.
 * A visited set also makes externally restored cyclic/deep graphs safe to view. */
export function buildThread(index: ReturnType<typeof indexPosts>, selectedId: string): ThreadEntry[] {
  let rootId = selectedId;
  const ancestors: string[] = [];
  const ancestorPositions = new Map<string, number>();
  while (true) {
    const position = ancestorPositions.get(rootId);
    if (position !== undefined) {
      // All selections within a cycle choose the same root.
      rootId = ancestors.slice(position).sort()[0]!;
      break;
    }
    ancestorPositions.set(rootId, ancestors.length);
    ancestors.push(rootId);
    const parent = index.byId.get(rootId)?.replyToId;
    if (!parent) break;
    rootId = parent;
  }
  const entries: ThreadEntry[] = [];
  const visited = new Set<string>();
  const stack = [{ id: rootId, depth: 0 }];
  while (stack.length) {
    const entry = stack.pop()!;
    if (visited.has(entry.id)) continue;
    visited.add(entry.id);
    entries.push({ ...entry, post: index.byId.get(entry.id) });
    const children = index.replies.get(entry.id) ?? [];
    for (let i = children.length - 1; i >= 0; i -= 1) {
      stack.push({ id: children[i]!.id, depth: entry.depth + 1 });
    }
  }
  return entries;
}
