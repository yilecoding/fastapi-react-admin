import { defineCollection } from 'astro:content'
import { z } from 'astro/zod'
import { docsLoader } from '@astrojs/starlight/loaders'
import { docsSchema } from '@astrojs/starlight/schema'

export const collections = {
  docs: defineCollection({
    loader: docsLoader(),
    schema: docsSchema({
      // 首页 hero 用到、Starlight 自己没有的两样：标题上方的一行等宽小字，和三枚标签
      extend: z.object({
        landing: z.object({ chips: z.array(z.string()).default([]) }).optional(),
      }),
    }),
  }),
}
