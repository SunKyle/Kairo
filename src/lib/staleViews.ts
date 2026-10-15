import type { CharacterViewKind } from '../types'

/* ===== 设定图的「待确认」清单 ==========================================
   角色身上的设定图有两种状态:跟得上当前基准的,与跟不上、等用户决定要不要
   重跑的。后者记在 `Character.staleViews` 上(见 types 的说明)。

   这一份只算「一次操作之后,清单该变成哪几张」—— 不碰存储、不碰界面。
   纯函数,好钉单测(见 staleViews.test.ts)。

   什么算「基准」:这个角色当前那张脸。它有两个来源会变 ——
   ① 正脸被重跑:其余每一张都是照上一张脸生的,全部过期;
   ② 设定被改:所有图(连正脸自己)都是照旧设定生的,同样过期。

   **为什么记一串 kind 而不是一个 bool**:重跑某一张之后要把它自己从清单里
   摘掉。只记 bool 的话摘不掉 —— 那张已经跟着新基准走了,却还被列在
   "待确认"里,用户会以为它还没跟上。
   -------------------------------------------------------------------- */

/** 去重,并保持传入的顺序(顺序由调用方给 —— 这一层不替它排) */
function uniq(list: readonly CharacterViewKind[]): CharacterViewKind[] {
  return Array.from(new Set(list))
}

/**
 * 重跑完一张设定图之后,新的「待确认」清单。
 *
 * - 重跑的是**正脸**:它是基准。其余每一张都是照上一张脸生的,全部过期;
 *   而正脸自己刚更新,不在清单里。
 *   **这一点被单测钉住** —— 界面上那句"这是改设定还是换脸"的判据就是
 *   "清单里有没有 front"(见 useCharacterDetail 的 staleNote)。哪天这里
 *   顺手把 front 也标进去,文案就会静默说反。
 * - 重跑的是**别的张**:它自己跟上了当前基准,从清单里摘掉;其余不动。
 *
 * @param kind     这一次刚生成好的那一张
 * @param existing 现在确实有图的那些 kind
 * @param marked   这一次之前就已经在「待确认」里的那些
 */
export function staleAfterGen(
  kind: CharacterViewKind,
  existing: readonly CharacterViewKind[],
  marked: readonly CharacterViewKind[]
): CharacterViewKind[] {
  if (kind === 'front') return uniq(existing.filter((k) => k !== 'front'))
  return uniq(marked.filter((k) => k !== kind))
}

/**
 * 改了设定之后,新的「待确认」清单:所有已经出过的图。
 *
 * 与 staleAfterGen 的区别是**正脸也在其中** —— 它不是"照旧脸生的",
 * 而是"照旧设定生的",一样对不上了。用户要跟上新设定,第一步就是重跑正脸。
 *
 * @param existing 现在确实有图的那些 kind
 */
export function staleAfterSpecChange(
  existing: readonly CharacterViewKind[]
): CharacterViewKind[] {
  return uniq(existing)
}

/**
 * 两份清单是不是同一批(不看顺序)。
 *
 * 用途只有一个:生成完之后,只在**真的变了**的时候才写一次盘 ——
 * 每张图都重写一遍角色目录是白写,而它顺带还会写一次参考图的 IndexedDB,
 * 并让别的标签页重读一遍角色。
 */
export function sameStale(
  a: readonly CharacterViewKind[],
  b: readonly CharacterViewKind[]
): boolean {
  if (a.length !== b.length) return false
  const set = new Set(b)
  return a.every((k) => set.has(k))
}
