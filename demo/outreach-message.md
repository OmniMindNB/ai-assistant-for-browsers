# Outreach message drafts

To send alongside the `trust-demo.html` recording when reaching out to named
QA engineers / third-party-page devs / CMS-editing growth-ops people. Two
lengths — pick based on how well you know the person.

## Short version (someone you know personally)

> 嘿，我在做一个浏览器 AI 插件，Runi——跟 Gemini in Chrome / Copilot 那种不一样的地方是：
> 每轮第一次写操作前会跟你确认，决定仅在该轮内复用；回答会引用具体的代码证据而不是瞎猜，模型也是你自己接的。你发起请求后，当前提示词、近期对话上下文和相关页面结果可能直接发送到你配置的 AI Provider。
> 录了个 60 秒的短片给你看看它怎么扛住一个藏在页面里的"骗它删数据"的指令：[demo clip link]
> 想请你实际用 3 天，就当日常改配置/调页面时顺手试试，第三天我们简单聊两句你的真实感受，哪怕觉得不好用也直接说。

## Longer version (weaker tie / cold-ish outreach)

> 你好，我是 [name]，在做一个叫 Runi 的浏览器 AI 插件。看你[具体来源：GitHub/公司/社群]
> 经常要处理[第三方页面调试 / QA 测试 / 后台字段配置]这类工作，想请你帮个忙。
>
> 市面上的浏览器 AI（Gemini in Chrome、Copilot、Comet 之类）常常锁定自家模型，控制边界也不透明。
> Comet 今年就出过一次真实的 prompt injection 漏洞。Runi 不一样：每轮第一次写操作前会跟你确认，
> 决定仅在该轮内复用；回答会点名引用具体的代码/DOM 证据，接的模型也是你自己配置的 API Key。你发起请求后，当前提示词、近期对话上下文和相关页面结果可能直接发送到你配置的 AI Provider。
>
> 附上一个 60 秒短片，是它扛住一个藏在页面里、诱导它"不问用户就删数据"的指令的实录：[demo clip link]
>
> 如果你愿意，想请你实际用 3 天——就是正常工作时顺手用，不用专门腾时间。第三天我发消息问问你的真实体验，
> 无论好坏都想听真话，这直接决定我接下来要不要继续做这个东西。

## Day-3 check-in prompt (send to yourself as a reminder)

> 三个问题，别客气：
> 1. 这 3 天有没有在没人提醒的情况下主动打开过 Runi？大概几次，用来干什么？
> 2. 有没有哪次是因为每轮第一次写操作前会确认、决定只在当轮有效，你才敢让它动手做一个本来不敢让 AI 碰的操作？
> 3. 如果现在把 Runi 卸载，你会觉得可惜吗？为什么，或者为什么不？
