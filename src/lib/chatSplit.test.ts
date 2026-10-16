import { describe, expect, it } from 'vitest'
import {
  bubblePositions,
  CHAT_SPLIT_MAX_BUBBLES,
  splitAssistantReply
} from './chatSplit'

/* 这一层守的是"怎么切得像人在连发,又不但心把一段完整的话切坏"的几条产品不变量,
   与 memory.test.ts / relationship.test.ts 同一套路:构造数据直接断,不靠"聊两句
   看看感觉对不对"。 */

describe('splitAssistantReply · 基本切分', () => {
  it('空文本 / 全空白 → 空数组(上层据此不留空气泡)', () => {
    expect(splitAssistantReply('')).toEqual([])
    expect(splitAssistantReply('   \n\n  \n ')).toEqual([])
  })

  it('一段话 → 原样回一片,不硬拆', () => {
    expect(splitAssistantReply('hello there')).toEqual(['hello there'])
    // 段内软换行是同一段的一部分,不算分隔
    expect(splitAssistantReply('line one\nline two\nline three')).toEqual([
      'line one\nline two\nline three'
    ])
  })

  it('按段落分:两片,每片自己 trim,段间连续空行只算一次分隔', () => {
    expect(splitAssistantReply('para one\n\npara two')).toEqual(['para one', 'para two'])
    expect(splitAssistantReply('para one\n\n\n\n\npara two')).toEqual(['para one', 'para two'])
    expect(splitAssistantReply('  leading\n\ntrailing  ')).toEqual(['leading', 'trailing'])
  })
})

describe('splitAssistantReply · 代码围栏', () => {
  it('```…``` 里的空行不当作段落分隔,整块留在同一格', () => {
    const code = '```\nconst a = 1\n\nconst b = 2\n```'
    const out = splitAssistantReply(`before\n\n${code}\n\nafter`)
    expect(out).toEqual(['before', code, 'after'])
    // 关键:代码块里那行空行还在原位,没被撕成两半
    expect(out[1]).toContain('\n\n')
  })

  it('未闭合的围栏(模型只写了一半 ```),不当分隔,内容一字不丢', () => {
    // 上游被截 / 半截围栏,不能因此把整段切成孤立的空段
    const out = splitAssistantReply('intro\n\n```\ncode line 1\n\ncode line 2')
    // 未闭合意味着从 ``` 起都算"块内",所以 intro 是一片、剩下是一块
    expect(out).toHaveLength(2)
    expect(out[1]).toContain('```')
    expect(out[1]).toContain('code line 2')
  })
})

describe('splitAssistantReply · 上限保护', () => {
  it('超过 4 段:前 (N-1) 片原样,剩下并入最后一格,一字不丢', () => {
    const five = 'a\n\nb\n\nc\n\nd\n\ne'
    const out = splitAssistantReply(five)
    expect(out).toHaveLength(CHAT_SPLIT_MAX_BUBBLES)
    expect(out[0]).toBe('a')
    expect(out[1]).toBe('b')
    expect(out[2]).toBe('c')
    // d 与 e 被并回第 4 片,用原段落分隔接起来 —— 内容不丢
    expect(out[3]).toBe('d\n\ne')
  })

  it('不多不少正好 4 段:原样,不动最后一格', () => {
    const out = splitAssistantReply('a\n\nb\n\nc\n\nd')
    expect(out).toEqual(['a', 'b', 'c', 'd'])
  })
})

describe('splitAssistantReply · 无损', () => {
  it('把结果用空行拼回来 == 原文按段落规范化后的形状', () => {
    // 不逐字节相等(连续空行会被压成一段,前后空白会被 trim),但**每一段**都还在
    const input = '\n  first para\n\n\n  second para\n\n  third para\n\n'
    const out = splitAssistantReply(input)
    expect(out).toEqual(['first para', 'second para', 'third para'])
    // 每一段的所有非空行,拼起来还是原文的所有非空行(顺序一致)
    const nonBlankLines = (s: string) =>
      s
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
    expect(nonBlankLines(out.join('\n\n'))).toEqual(nonBlankLines(input))
  })
})

describe('bubblePositions · 组内索引', () => {
  it('给 count 出 [0, 1, ..., count-1],0/负数当空数组', () => {
    expect(bubblePositions(0)).toEqual([])
    expect(bubblePositions(-3)).toEqual([])
    expect(bubblePositions(1)).toEqual([0])
    expect(bubblePositions(3)).toEqual([0, 1, 2])
  })
})
