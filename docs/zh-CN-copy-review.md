# Socrates — 简体中文文案审校 / Chinese copy review

**311 strings** across nine screens. For each: the English it replaces, the Chinese now shipping, and what the string is *for* — when a reader sees it and what it has to accomplish.

The last column is the one to read first.

| | count | what it means for review |
|---|---|---|
| 🟢 **From the comp** | 131 | Still verbatim `Socrates zh-CN.dc.html`. Your own copy — I changed nothing. Review only if the comp itself needs revising. |
| 🟡 **Written to match** | 180 | The comp drew seven screens but not every state, and the product has since grown three surfaces it never drew. These were translated against the comp's own pairs as a style guide. **This is the part that needs a native reader.** |

A string is green only where two independent checks agree: the record kept while translating, *and* a fresh character-for-character match against the comp file. Green tells you to skip a string, so a wrong green costs that string its review, while a wrong yellow costs you a glance. Where the two disagreed I marked it yellow.

---

## Before you start

**The voice.** The comp set an unusual register — measured, slightly literary, closer to written than spoken Chinese. 此番不中 for a wrong answer rather than 错误; 考察，自一概念始 for an eyebrow label. Everything in 🟡 was written to sit alongside that. Where it slips into ordinary software Chinese, that is a defect worth reporting even if the meaning is right.

**What deliberately stays Latin**, per the comp: the `Socrates` wordmark, the `D1`–`D6` depth codes, `Batch API`, `token`, `API`, the Greek `Τέλος` and `Γνῶθι σεαυτόν`, and literal settings such as `GYM_PRICES` and the `[contested]` keyword a user types.

**What is never translated at all:** concept names, node titles, node descriptions, question text, options, rationales and misconception labels. Those are the learner's own material, stored in the database, and translating them would corrupt what they are studying.

**Placeholders** such as `{count}` or `{emphasis}` are replaced at runtime with an already-formatted value. They must survive translation with the same names — but they may move within the sentence, and in several places they had to. Do not add a percent sign, currency symbol or digit grouping around one; the value arrives carrying its own.

**One deliberate departure from the comp.** The comp shows `¥`. The figures come from Anthropic API billing and are US dollars, so a `¥` in front of an unconverted number would state an amount that is simply false. Currency stays in dollars in both languages. A real redenomination needs an exchange rate and a rounding rule — a product decision rather than a translation — and the note reading “Dollars are estimated” would have to change with it.

---

## Where the shipped copy has moved away from the comp

The comp was drawn against an earlier product. Eight strings it *did* draw are no longer what ships, and three whole surfaces did not exist when it was drawn. All of it is marked 🟡 below, but it is worth knowing as a group, because in each case the comp is not simply a better version I failed to use:

| what the comp drew | what ships | why |
|---|---|---|
| 此馆已上锁。 · 口令 · “一道口令，众人共用…” | 训练馆已上锁。 · 密码 · “你的记录跟随账户，而非设备…” | The deployment moved from one shared password to real accounts. The comp's lede describes a product that no longer exists — it promised that one 口令 stood between the world and the API key. `密码` rather than `口令` follows from that: it is now your own credential, not a house key. **Worth a hard look** — this is the largest rewrite in the set. |
| 考察，自一概念始 | 致知在格物 | The eyebrow on the first screen became a classical epigraph (《礼记·大学》). It says something adjacent rather than the same thing: *knowledge comes from the investigation of things* rather than *the examination begins with a subject*. If that is too oblique for a first-run screen, the comp's line is the safe revert. |
| “先写下一个概念，再把你正读的材料贴进来。此处不作讲授…” | “写下一个概念，贴上你正读的材料——我不讲授…” | Same argument, roughly 40% shorter, to survive a phone screen. The comp's is better prose. If it fits your layout, take it back. |
| Γνῶθι σεαυτόν — 认识你自己；不过，先说明你是谁 | Γνῶθι σεαυτόν——但请先表明身份 | Shortened for the same reason. The comp keeps the gloss 认识你自己, which is the half a reader who does not read Greek actually gets. |
| `¥` | `$` | See the note above. |

**The three surfaces the comp never drew**, all necessarily 🟡: registration and sign-in (`login.signup*`, `login.to*`, `login.code*`), the shared concept library (`concepts.library*`, `concepts.sharedConceptNote`), and the “I don't know” answer path (`session.dontKnow*`, `session.feedback*DontKnow`). The last is the one to read closely: saying you do not know must feel like a legitimate move rather than a forfeit, or learners will guess instead, and a guess teaches the student model the wrong thing.

---

## Chrome — 页眉

*The sticky header on every screen, plus the spend popover it opens.*

Visible constantly, so it must read as furniture rather than content. The nav labels are the app's own vocabulary and set the terms every other screen reuses: whatever 蓝图 / 总览 / 题目健康 / 基准集 mean here, they must mean the same thing everywhere else.

<sub>27 strings · 🟢 5 from the comp · 🟡 22 written to match</sub>

| | Key | English | 中文 | What it is for |
|---|---|---|---|---|
| 🟢 | `wordmark` | Socrates | **Socrates** | Product name. Left in Latin throughout, as the comp has it. |
| 🟢 | `navBlueprint` | Blueprint | **蓝图** | Nav link to the knowledge map. |
| 🟢 | `navDashboard` | Dashboard | **总览** | Nav link to the progress overview. |
| 🟢 | `navItemHealth` | Item health | **题目健康** | Nav link to question-bank statistics. |
| 🟢 | `navBenchmark` | Benchmark | **基准集** | Nav link to the frozen measurement set. |
| 🟡 | `spendChipTitle` | Estimated spend this month | **本月支出估算** | Hover tooltip on the cost chip in the header. |
| 🟡 | `spendChipAriaLabel` | Estimated spend this month: {amount} | **本月支出估算：{amount}** | Screen-reader name for the chip when no budget is set. The visible text is only a number, which says nothing aloud on its own. |
| 🟡 | `spendChipAriaLabelWithBudget` | Estimated spend this month: {amount} of a {limit} budget | **本月支出估算：{amount}，预算 {limit}** | Same, when a monthly budget is configured. |
| 🟡 | `spendChipAriaLabelWithBudgetReached` | Estimated spend this month: {amount} of a {limit} budget, budget reached | **本月支出估算：{amount}，预算 {limit}，已达上限** | Same, once the budget estimate is used up — the state must be audible, not only visible as colour. |
| 🟡 | `spendPanelAriaLabel` | Estimated spend | **支出估算** | Screen-reader name of the popover the chip opens. |
| 🟡 | `spendPanelHeading` | Estimated spend · {month} | **支出估算 · {month}** | Heading inside the popover. {month} is a YYYY-MM string. |
| 🟡 | `closeButtonLabel` | Close | **关闭** | The × that dismisses the popover. |
| 🟡 | `figureToday` | Today | **今日** | Figure label: spend since midnight. |
| 🟡 | `figureThisMonth` | This month | **本月** | Figure label: spend this calendar month. |
| 🟡 | `figureBudget` | Budget | **预算** | Figure label: the configured monthly ceiling. |
| 🟡 | `figureAheadOfUse` | Ahead of use | **预生成未用** | Figure label: money already spent on questions generated in advance but not yet shown. The concept is unusual and the phrase carries it — not waste, but spending that runs ahead of use. |
| 🟡 | `aheadOfUseHint` | {count} generated, not yet served | **已生成 {count} 道题，尚未施测** | Sub-label under that figure. {count} is a question count. |
| 🟡 | `budgetReachedWarning` | The monthly budget estimate has been reached, so pre-generation is paused. Sessions still run — items are generated as you reach them, which is slower and only spends on questions you actually see. | **本月预算估算已达上限，预生成因此暂停。会话仍照常进行——题目待你行至该处时才生成，如此较慢，但只为你真正看到的题目付费。** | Shown when the budget is spent. The reassurance is the important half: training still works, it just stops buying questions in advance. Someone who reads this as "the app has stopped" will abandon it. |
| 🟡 | `tableHeaderCall` | Call | **调用** | Table column: which kind of model call (writing a question, checking it, drawing a map, grading). |
| 🟡 | `tableHeaderCalls` | Calls | **调用次数** | Table column: how many such calls. |
| 🟡 | `tableHeaderOutputTokens` | Output tokens | **输出 token 数** | Table column: tokens produced. Output is ~90% of the cost, which is why this column and not input. |
| 🟡 | `tableHeaderEstimated` | Estimated | **估算** | Table column: estimated money. |
| 🟡 | `batchShareNote` | {percent}% of {calls} calls went through the Batch API at half rate. | **{calls} 次调用中有 {percent}% 经 Batch API 以半价计费。** | How much of the spend went through the half-price asynchronous API. Diagnostic: a low share means a discount is not landing. |
| 🟡 | `batchShareNoteNone` | {percent}% of {calls} calls went through the Batch API at half rate — none yet, so nothing is discounted. | **{calls} 次调用中有 {percent}% 经 Batch API 以半价计费——尚无一次，故并无折扣。** | Same, worded for zero — the reader needs to know nothing is discounted yet. |
| 🟡 | `priceTableNote` | Token counts are exact. Dollars are estimated from a built-in price table that may be out of date — set {envVar} to correct it. | **token 计数精确。金额由内置价格表估算，该表可能已过时——设置 {envVar} 可加以校正。** | The disclaimer under the figures. The distinction is the point: token counts come from the API and are exact, the money is an estimate off a table that can go stale. {envVar} is a literal setting name and stays Latin. |
| 🟡 | `currencySymbol` | $ | **$** | Currency prefix. Deliberately NOT ¥ — see the note on currency above. |
| 🟡 | `amountBelowCent` | <$0.01 | **<$0.01** | Shown instead of $0.00 when a real amount rounds below a cent. |

## Concepts — 概念

*The landing screen: name a subject, paste the material, start.*

The first thing a new reader sees, and the only place the product explains what it is. The lede has to convey that this is not a tutor that lectures — it decomposes your material and interrogates you against it.

<sub>37 strings · 🟢 14 from the comp · 🟡 23 written to match</sub>

| | Key | English | 中文 | What it is for |
|---|---|---|---|---|
| 🟢 | `topbarSubtitle` | the endless knowledge gym | **无尽的心智练习之馆** | Header subtitle on the landing and login screens. Sets the tone for the whole product in five words. |
| 🟡 | `eyebrow` | The examination begins with a subject | **致知在格物** | Small label above the main heading. |
| 🟢 | `heading` | What shall we {emphasis}? | **这一回要{emphasis}的，是什么？** | The main heading. {emphasis} is replaced by the accented word below, which is coloured rather than italicised. |
| 🟢 | `headingEmphasis` | examine | **弄明白** | The emphasised word inside that heading. |
| 🟡 | `lede` | Name a concept and paste what you are learning it from. I will not lecture you — I will decompose the material, question you against the map, and keep coming back to the parts you cannot yet hold. | **写下一个概念，贴上你正读的材料——我不讲授，只拆解、发问，一再回到你尚未把握之处。** | The product's own description of itself. The key claim: it will not lecture — it takes your material, breaks it into a map, and questions you against that map, returning to what you have not yet grasped. |
| 🟢 | `nameInputPlaceholder` | Socialism, Bayes' theorem, CSS specificity… | **社会主义、贝叶斯定理、CSS 优先级……** | Placeholder in the concept-name field. Three deliberately unlike examples, to show the tool is not subject-specific. |
| 🟡 | `nameInputAriaLabel` | Concept name | **概念名称** | Screen-reader name for that field. |
| 🟢 | `beginButton` | Begin | **开始** | Submits the new concept. |
| 🟡 | `beginButtonBusy` | Working… | **处理中……** | Busy label on that button. |
| 🟢 | `addSourceButton` | Add source material | **添加原始材料** | Opens the optional source-material fields. |
| 🟡 | `hideSourceButton` | Hide source | **隐藏原始材料** | Collapses them again. |
| 🟢 | `noSourceWarning` | Without source text, generation falls back to the textbook version of the concept and systematically misses whatever is idiosyncratic about your understanding. | **若不添加材料，生成只能照教科书的说法出题，你理解中独特的部分会被系统性地漏掉。** | Shown when no material has been pasted. The warning is specific and worth preserving exactly: without your text, questions test the textbook version of the topic and will systematically miss whatever is particular to your own understanding. |
| 🟡 | `sourceTextLabel` | Source material | **原始材料** | Field label for the pasted material. |
| 🟡 | `sourceTextPlaceholder` | Paste the chapter, paper, lecture notes, or documentation you are learning this from. Every node and every item is grounded in this. | **把你据以学习的章节、论文、课堂笔记或文档贴进来。每一个节点、每一道题都本于此。** | Placeholder for that field. The last sentence matters: every node and every question is grounded in this text. |
| 🟡 | `sourceNoteLabel` | Where it came from | **出自何处** | Field label for the provenance of the material. |
| 🟡 | `sourceNotePlaceholder` | Ch. 4 of …  (add [contested] to force the politically-neutral prompt variant) | **《……》第 4 章（加上 [contested] 可强制使用政治中立的提示词变体）** | Placeholder. [contested] is a literal keyword the user types to force a politically-neutral prompt variant, and must stay Latin. |
| 🟡 | `hintsLabel` | Hints for the decomposition (optional) | **给拆解的提示（可选）** | Optional field: guidance for how to break the material up. |
| 🟡 | `hintsPlaceholder` | e.g. keep the historical material separate from the theoretical claims | **例如：把历史材料与理论主张分开** | Example hint. |
| 🟡 | `statusCreating` | Creating the concept… | **正在创建概念……** | Progress line while the concept record is written. |
| 🟡 | `statusDecomposing` | Decomposing the source into a blueprint. This takes a minute — it is one large call, and the map it produces is what every item is generated against. | **正在把原始材料拆成一张蓝图。这要等上一分钟——这是一次大的调用，而它画出的图，正是每一道题据以生成之图。** | Progress line during the long map-building call. It explains a wait of a minute or more, and why that wait is worth it — everything downstream is generated against this map. |
| 🟡 | `errorCreateFailed` | could not create the concept | **未能创建概念** | Fallback error if the concept cannot be created. |
| 🟡 | `errorBlueprintFailed` | blueprint generation failed | **蓝图生成失败** | Fallback error if the map cannot be built. |
| 🟢 | `listSectionLabel` | Under examination | **正在考察** | Heading above the list of existing concepts. |
| 🟢 | `dueBadge` | {count} due | **{count} 项到期** | Badge on a concept card: how many cells are due for review. {count} is a number. |
| 🟢 | `coveredStat` | {percent}% covered | **已覆盖 {percent}%** | Card statistic: share of the map reached so far. |
| 🟢 | `nodesStat` | {count} nodes | **{count} 个节点** | Card statistic: how many sub-concepts the map has. |
| 🟢 | `degradedModeNote` | No source material — degraded mode. | **无原始材料——降级模式。** | Card note for a concept created without source material. |
| 🟡 | `sharedConceptNote` | Shared — the canonical version of this topic, and its bank is everyone’s. | **共享——本主题的通用版本，题库属于所有人。** | Marks a concept whose map and question bank are shared across everyone rather than private to one learner. The progress record stays personal; only the material is common. |
| 🟡 | `librarySectionLabel` | Already decomposed | **已有人拆解** | Heading over concepts someone has already decomposed, which you can adopt instead of building your own. |
| 🟡 | `libraryNote` | Concepts other people have mapped. Joining one gives you their blueprint and their item bank; your mastery starts where it should, at nothing. | **他人已绘制的概念。加入即可获得其蓝图与题库；你的掌握度理应从零开始。** | Sits under the library heading and explains what joining actually transfers. Two claims have to survive: the blueprint and the item bank come with you, and mastery does not — you start at zero on someone else’s map. A reader who thinks joining imports progress will distrust the dashboard on day one. |
| 🟡 | `libraryBankSize` | {count} items written | **已写 {count} 道题** | How many questions have already been written for a shared concept — the reason adopting one is cheaper than starting fresh. |
| 🟡 | `libraryJoinButton` | Take it up | **接手** | Adopts a shared concept. You get the existing map and bank; your mastery record starts empty. |
| 🟡 | `libraryJoinButtonBusy` | Joining… | **加入中……** | Busy label while joining. |
| 🟢 | `blueprintLink` | Blueprint | **蓝图** | Card link to the map. |
| 🟢 | `trainButton` | Train | **训练** | Card button that starts a session. |
| 🟡 | `trainButtonBusy` | Assembling… | **组卷中……** | Busy label while the session is being planned. |
| 🟡 | `errorSessionStartFailed` | could not start a session | **未能开始会话** | Fallback error if a session cannot start. |

## Session — 会话

*The training loop itself: one question, an answer, feedback.*

The screen a learner spends nearly all their time on. Tone matters more here than anywhere: the feedback must be exacting without being punitive, because the whole design rests on someone being willing to be wrong in front of it repeatedly.

<sub>54 strings · 🟢 16 from the comp · 🟡 38 written to match</sub>

| | Key | English | 中文 | What it is for |
|---|---|---|---|---|
| 🟡 | `benchmarkRunSubtitle` | benchmark run | **基准测评** | Header subtitle during a benchmark run rather than ordinary practice. |
| 🟡 | `loadingConsidering` | Considering what you do not yet know | **正思量你尚未知晓之处** | One of four rotating messages while the next question is prepared. They exist to make a wait feel deliberate rather than broken. |
| 🟡 | `loadingFraming` | Framing the next question | **正拟下一题** | Second rotating wait message. |
| 🟡 | `loadingSharpening` | Sharpening the objection | **正磨砺诘难** | Third. "Objection" in the Socratic sense — the challenge being put to you. |
| 🟡 | `loadingHarderCase` | Choosing the harder case | **正择更难的一例** | Fourth. |
| 🟡 | `errorFetchNextItem` | could not fetch the next item | **未能取得下一题** | Fallback error if the next question cannot be fetched. |
| 🟡 | `errorRecordAnswer` | could not record that answer | **未能记下这次作答** | Fallback error if an answer cannot be recorded. |
| 🟡 | `askAgain` | Ask again | **再问一次** | Retry button after such an error. |
| 🟢 | `progressCount` | {answered}/{total} | **{answered}/{total}** | Progress counter, answered over planned. |
| 🟢 | `endEyebrow` | Τέλος — the account of this session | **τέλος · 此番会话的账目** | Label on the end-of-session panel. Τέλος is Greek for "end" and stays Greek, as in the comp. |
| 🟢 | `endItemsAnswered` | {answered} of {total} planned items answered. | **计划的 {total} 题已作答 {answered} 题。** | End-of-session summary line. |
| 🟡 | `endBenchmarkNote` | The benchmark result is on the benchmark screen. | **基准测评的结果见基准集页面。** | Extra end line after a benchmark run, pointing at where the result is. |
| 🟢 | `endMasteryNote` | Mastery estimates and the next due dates have been updated. | **掌握度估计与下次到期日期均已更新。** | Extra end line after practice: what the session changed. |
| 🟢 | `seeDashboard` | See the dashboard | **查看总览** | End-of-session link. |
| 🟢 | `backToConcepts` | Back to concepts | **返回概念列表** | End-of-session link. |
| 🟢 | `questionCounter` | Question {position} of {total} | **第 {position} 题 / 共 {total} 题** | Position within the session, above the question. |
| 🟡 | `yourAnswerLabel` | Your answer | **你的作答** | Label above the free-text answer box. |
| 🟡 | `freeAnswerPlaceholder` | Write it out. You will be graded on what is literally here, not on what you meant. | **写出来。评判所据，是此处字面写下的，而非你意欲表达的。** | Placeholder in that box. The warning is deliberate and central: grading is on what the answer literally says, not on what was meant. |
| 🟢 | `confidencePrompt` | Before you submit — how sure are you? | **提交前——你有多确定？** | Asks for confidence BEFORE the answer is submitted. This is the single most important interaction in the product — right-and-confident, right-and-guessing, wrong-and-unsure and wrong-and-confident are four different states, and a score alone collapses them. |
| 🟡 | `confidenceGroupLabel` | Confidence | **确信程度** | Screen-reader name for the confidence control. |
| 🟡 | `confidenceGuessing` | Guessing | **猜测** | Confidence option: no idea, picking anyway. |
| 🟡 | `confidenceUnsure` | Unsure | **不确定** | Confidence option: leaning one way, not sure. |
| 🟡 | `confidenceConfident` | Confident | **确定** | Confidence option: sure. Choosing this and being wrong is the strongest signal in the system, so it must not feel like the safe default. |
| 🟢 | `submit` | Submit | **提交** | Submits the answer. |
| 🟡 | `submitting` | Submitting… | **提交中……** | Busy label while submitting. |
| 🟡 | `recording` | Recording… | **记录中……** | Busy label while the response is written down. |
| 🟡 | `submitHintChooseOption` | Choose an option. Number keys work too. | **选一个选项。数字键亦可。** | Hint under the submit button when no option has been picked yet. |
| 🟡 | `submitHintWriteAnswer` | Write your answer. | **写下你的作答。** | Hint when the written-answer box is still empty. |
| 🟡 | `submitHintConfidence` | How sure are you? Answer that before you submit — it is half the signal. | **你有多确定？提交之前先答此问——它是信号的一半。** | Hint when an answer is chosen but confidence has not been set. The phrase "half the signal" is the argument for why confidence is mandatory rather than optional. |
| 🟡 | `submitHintReady` | Ready. Press Enter. | **就绪。按 Enter 提交。** | Hint when everything needed has been supplied. |
| 🟡 | `countdownRemaining` | Sit with it — {seconds}s | **且思之——{seconds} 秒** | A deliberate pause before the answer can be revealed. "Sit with it" asks for retrieval effort — the struggle before seeing the answer is where the learning happens, so this is not an artificial delay. |
| 🟡 | `dontKnow` | I don't know | **我不知道** | Explicitly declares not knowing, rather than guessing. |
| 🟡 | `dontKnowHint` | This records the item as not known, then shows the answer. Like any answer, the record stands. | **此举先把此题记作「未知」，再揭出答案。与作答一样，记录既下，不可更改。** | Explains what that button does and, importantly, that the record stands — declaring ignorance is honest, not free. |
| 🟡 | `feedbackHeadDontKnow` | You did not know it. | **此题你尚不知。** | Headline after declaring not knowing. Neither congratulation nor reprimand: a flat acknowledgement. |
| 🟡 | `feedbackEyebrowDontKnow` | here it is, and why | **答案在此，及其所以然** | Label above the explanation in that case. |
| 🟡 | `dontKnowFreeSummary` | You passed on this one. A passing answer must contain each of the following. | **此题你未作答。合格的答案，须含以下各项。** | Shown for a passed-on written question, listing what a passing answer would have had to contain. |
| 🟡 | `dontKnowCriterionNote` | Unanswered, so unmet. | **未作答，故未达成。** | Marks each rubric criterion in that case — unanswered, therefore unmet. |
| 🟢 | `verdictCorrect` | correct | **正解** | Tag on the option that was actually right. |
| 🟢 | `verdictYourChoice` | your choice | **你的选择** | Tag on the option the learner picked. |
| 🟡 | `feedbackHeadCorrect` | Just so. | **正是如此。** | Headline when the answer was right. Approving without being congratulatory — the design deliberately avoids rewarding correctness, because reward pushes people toward easy questions. |
| 🟢 | `feedbackHeadWrong` | Not this time. | **此番不中。** | Headline when the answer was wrong. It must land as a plain statement of fact, not a reprimand. |
| 🟡 | `feedbackEyebrowCorrect` | the principle beneath it | **其下所据之理** | Label above the explanation after a correct answer. |
| 🟢 | `feedbackEyebrowWrong` | here is where it turns | **分歧正在此处** | Label above the explanation after a wrong one — literally, this is the point where the reasoning goes astray. |
| 🟡 | `criteriaMetSummary` | {met} of {criteria} criteria met · {score}% (pass at {threshold}%) | **{criteria} 项标准中达成 {met} 项 · {score}%（通过线 {threshold}%）** | Score line for a written answer, against its rubric. |
| 🟢 | `misconceptionAttribution` | You chose the answer someone believing {misconception} would choose. | **你所选的，正是持「{misconception}」此一信念之人会选的。** | Names the specific false belief the chosen answer implies. Not "you were wrong" but "this is the belief that answer belongs to" — the distinction is the whole instructional value of a distractor. |
| 🟢 | `nextQuestion` | Next question | **下一题** | Advances to the next question. |
| 🟢 | `orPressKey` | or press {key} | **或按 {key}** | Keyboard hint beside that button. {key} is a key name such as Enter and stays Latin. |
| 🟡 | `criterionUnmetFallback` | Nothing in the answer meets this. | **答中无一处合于此。** | Shown against a rubric criterion the answer did not satisfy. |
| 🟡 | `criterionMet` | met | **达成** | Tag on a satisfied criterion. |
| 🟡 | `criterionNotMet` | not met | **未达成** | Tag on an unsatisfied one. |
| 🟡 | `whatWasAbsent` | What was absent | **所缺者** | Heading over what a written answer failed to say. Absence rather than error — the point is what was missing, not what was wrong. |
| 🟡 | `beliefsRevealed` | Beliefs the answer positively reveals | **作答明确显露出的信念** | Heading over false beliefs the answer actively showed, as opposed to merely omitted. |
| 🟡 | `endSession` | I'm done | **到此为止** | Ends the session early. |
| 🟡 | `endSessionClosing` | Closing… | **结束中……** | Busy label while closing. |

## Dashboard — 总览

*What the learner actually knows, and what is decaying.*

A reporting surface. Its job is to be honest about uncertainty — several labels carry deliberate hedges ("decayed, not raw", "advisory") that must survive translation, because without them the numbers read as more solid than they are.

<sub>35 strings · 🟢 22 from the comp · 🟡 13 written to match</sub>

| | Key | English | 中文 | What it is for |
|---|---|---|---|---|
| 🟢 | `eyebrow` | Where you actually are | **你实在所处之地** | Label above the concept name. Blunt on purpose. |
| 🟢 | `trainNowButton` | Train now | **开始训练** | Starts a session from the dashboard. |
| 🟢 | `editBlueprintLink` | Edit the blueprint | **编辑蓝图** | Link to the map. |
| 🟡 | `noSourceWarning` | No source material on this concept. Items test the canonical version of the topic and will miss whatever is specific to what you are actually reading. | **此概念没有原始材料。题目只考察这一主题的通行说法，你实际所读之中特有的部分都会被漏掉。** | Shown for a concept with no pasted material. |
| 🟢 | `coverageTileLabel` | Coverage | **覆盖率** | Statistic tile: share of the map reached. |
| 🟢 | `masteredCellsTileLabel` | Mastered cells | **已掌握单元** | Statistic tile: cells passed. A "cell" is one sub-concept at one depth level — the atomic unit of both mastery and scheduling. |
| 🟢 | `dueNowTileLabel` | Due now | **当前到期** | Statistic tile: cells due for review now. |
| 🟢 | `depthFrontierTileLabel` | Depth frontier | **深度前沿** | Statistic tile: the deepest level currently being served. The system does not go deeper until most nodes are solid at the level below. |
| 🟢 | `responsesTileLabel` | Responses | **作答总数** | Statistic tile: total answers recorded. |
| 🟢 | `masteryGridLabel` | Mastery grid — decayed, not raw | **掌握度网格——已按遗忘折算，非原始估计** | Heading over the heat grid. The hedge is essential: what is shown is mastery discounted for time elapsed since the last review, not the raw estimate. |
| 🟢 | `misconceptionProfileLabel` | Misconception profile — ranked by recent selection | **误解画像——按近期被选次数排序** | Heading over the list of false beliefs, ranked by how recently and often they were chosen. |
| 🟡 | `misconceptionProfileEmpty` | Nothing recorded yet. | **尚无记录。** | Empty state for that list. |
| 🟢 | `activeBeliefsNote` | {count} beliefs selected twice or more in the last 20 responses. Those nodes now get a remediation slice at the top of every session, with the same belief put back in the option set. | **最近 20 次作答中有 {count} 项信念被选中两次或以上。相关节点从现在起会在每次会话开头获得一段补救配额，并把同一信念放回选项中。** | Explains what an "active" false belief triggers: those nodes get a remediation slice at the top of every session, with the same belief put back among the options. The point is that a wrong idea is re-tested rather than avoided — avoidance would let it survive untouched. |
| 🟢 | `misconceptionSelectionCount` | {total}× total · {recent} recent | **共 {total} 次 · 近期 {recent} 次** | How often a belief was chosen, in total and recently. |
| 🟢 | `dueForecastLabel` | Due forecast — next 14 days | **到期预测——未来 14 天** | Heading over the fortnight forecast of review load. |
| 🟡 | `dueForecastBarTitle` | {date}: {count} cell(s) | **{date}：{count} 个单元** | Tooltip on a bar in the due-date forecast. |
| 🟢 | `dueForecastNote` | {count} cells fall due in the next fortnight. The leftmost bar includes everything already overdue. | **未来两周内有 {count} 个单元到期。最左侧一根包含所有已逾期的部分。** | Caption under it. The note about the leftmost bar matters — overdue work is folded into the first column rather than hidden. |
| 🟢 | `retentionLabel` | Retention — mean mastery after each day's work | **留存——每日练习后的平均掌握度** | Heading over the retention chart: average mastery after each day of work. |
| 🟡 | `retentionEmpty` | No responses yet. | **尚无作答。** | Empty state for the retention chart. |
| 🟡 | `retentionBarTitle` | {date}: {percent}% over {count} response(s) | **{date}：{percent}%，基于 {count} 次作答** | Tooltip on a retention bar. |
| 🟢 | `retentionNote` | Generated items drift in difficulty, so this line is not a measurement of progress. The {link} is. | **生成的题目难度会漂移，因此这条线不是进步的度量。可作度量的是{link}。** | The disclaimer under that chart, and an important one. Generated questions drift in difficulty, so a rising line is not evidence of progress; only the frozen set can tell those apart. {link} is a clickable phrase. |
| 🟢 | `retentionNoteLink` | frozen benchmark | **冻结的基准集** | The clickable phrase inside that sentence. |
| 🟢 | `benchmarkHistoryLabel` | Benchmark history | **基准集历史** | Heading over past benchmark runs. |
| 🟡 | `benchmarkHistoryEmpty` | No benchmark runs yet. Practice on generated items; measure on frozen ones — {link} to the benchmark set, then run it. | **尚无基准测评记录。练习用生成的题目，度量用冻结的题目——{link}，再运行一轮。** | Empty state for benchmark history. It contains the product's core measurement argument — practise on generated questions, measure on frozen ones — and {link} is a clickable phrase inside the sentence. |
| 🟡 | `benchmarkHistoryEmptyLink` | promote some validated items | **把若干已校验的题目升入基准集** | The clickable phrase inside that sentence. |
| 🟢 | `nodeColumnHeader` | Node | **节点** | The first column of the grid, listing sub-concepts. |
| 🟡 | `depthColumnTitle` | {name} — {definition} | **{name}——{definition}** | Tooltip on a depth column header, giving that level's definition. |
| 🟢 | `legendNeverTested` | never tested | **从未测过** | Grid legend: cells never tested, drawn unfilled rather than coloured, because a starting estimate is not evidence. |
| 🟢 | `legendDue` | due | **到期** | Grid legend: cells due for review. |
| 🟢 | `legendNotApplicable` | not applicable | **不适用** | Grid legend: cells the map marked meaningless at that depth. |
| 🟡 | `cellLabelNotApplicable` | {node} · D{depth} — marked not applicable | **{node} · D{depth}——已标记为不适用** | Tooltip on a grid cell the map marked as not meaningful at that depth. |
| 🟡 | `cellLabelNeverTested` | {node} · D{depth} — never tested (prior {prior}%) | **{node} · D{depth}——从未测过（先验 {prior}%）** | Tooltip on a cell never yet tested. It is rendered unfilled rather than coloured, because a starting estimate is not evidence. |
| 🟡 | `cellLabelTested` | {node} · D{depth} — effective {effective}% (estimate {estimate}%, retrievability {retrievability}%), {count} response(s) | **{node} · D{depth}——折算后 {effective}%（估计值 {estimate}%，可提取性 {retrievability}%），{count} 次作答** | Tooltip on a tested cell. Three numbers: the raw estimate, retrievability (how much has survived the time since), and the effective figure that combines them. |
| 🟡 | `cellLabelMasteredSuffix` | , mastered | **，已掌握** | Appended to that tooltip when the cell counts as mastered. |
| 🟡 | `cellLabelDueSuffix` | , due now | **，当前到期** | Appended when it is due for review. |

## Blueprint — 蓝图

*The knowledge map: nodes across, depth levels down, editable by hand.*

The largest namespace, because this is the screen the product most wants people to use. The framing is unusual and load-bearing: the map is a fallible artifact, editing it by hand is the intended workflow rather than a fallback, and every generated question inherits its errors.

<sub>61 strings · 🟢 30 from the comp · 🟡 31 written to match</sub>

| | Key | English | 中文 | What it is for |
|---|---|---|---|---|
| 🟢 | `eyebrow` | The blueprint — nodes across, depth down | **蓝图——节点横排，深度纵列** | Label above the concept name, describing the grid's orientation. |
| 🟢 | `lede` | This map is a knowledge artifact and it can be wrong. Every item inherits its errors, so a wrong blueprint produces well-formed items testing the wrong things — with scores that look fine. Edit it by hand. That is not a fallback, it is the intended workflow. | **这张图是一件知识的制品，它可能是错的。每一道题都承其错误：图既画偏，所出之题形式完好，考察的却是别的东西，而分数看去毫无异样。请动手改它。这不是退路，本就是既定的做法。** | The screen's thesis, and the most important paragraph in the product. The map can be wrong; every question inherits its errors; a wrong map yields well-formed questions testing the wrong things, with scores that look perfectly healthy. Editing it by hand is the intended workflow, not a fallback. |
| 🟡 | `nothingToSaveError` | Nothing to save — paste the material first. | **无可保存——先把材料贴进来。** | Validation error when saving empty source material. |
| 🟡 | `noSourceWarning` | This concept has no source text. Generation is running in a degraded mode: items will test the canonical textbook version and systematically miss whatever is idiosyncratic about your own material. | **此概念尚无原始材料。生成正以降级模式运行：所出之题只考教科书上的标准说法，你自己材料中独特的部分会被系统性地漏掉。** | Shown for a concept with no material. "Degraded mode" is the product's own term for it. |
| 🟡 | `addSourceTextButton` | Add source text | **添加原始材料** | Opens the source-material editor when none exists. |
| 🟢 | `editSourceTextButton` | Edit source text | **编辑原始材料** | Opens it when material already exists. |
| 🟢 | `sourceChangeNote` | Changing it does not change the existing map — regenerate afterwards to redraw against the new material. | **改动材料不会改动现有的图；改完后请重新生成，才会依新材料重画。** | Warns that changing the material does not redraw the existing map by itself. |
| 🟡 | `sourceMaterialLabel` | Source material | **原始材料** | Field label. |
| 🟡 | `sourceTextPlaceholder` | Paste the chapter, paper, lecture notes, or documentation you are learning this from. Every node and every item is grounded in this. | **把你正据以学习的章节、论文、讲义或文档贴进来。每一个节点、每一道题，皆本于此。** | Placeholder for the material field. |
| 🟡 | `sourceNoteLabel` | Where it came from | **出自何处** | Field label for provenance. |
| 🟡 | `sourceNotePlaceholder` | Ch. 4 of …  (add [contested] to force the politically-neutral prompt variant) | **《……》第 4 章（加上 [contested] 可强制使用政治中立的提示词变体）** | Placeholder. [contested] is a literal keyword and stays Latin. |
| 🟡 | `savingBusy` | Saving… | **正在保存……** | Busy label while saving. |
| 🟡 | `saveAndRedrawButton` | Save and redraw the map | **保存并重画此图** | Saves and rebuilds the map from the new material. |
| 🟡 | `saveOnlyButton` | Save only | **仅保存** | Saves without rebuilding. |
| 🟡 | `cancelButton` | Cancel | **取消** | Abandons the edit. |
| 🟡 | `redrawMergeNote` | Redrawing merges rather than replaces: nodes that survive keep their mastery, scheduling and response history. | **重画是合并，不是替换：留存下来的节点保有原有的掌握度、复习排期与作答记录。** | Reassurance before a rebuild: it merges rather than replaces, so surviving nodes keep their mastery, scheduling and answer history. Without this people will not dare press the button. |
| 🟡 | `saveFailedError` | save failed | **保存失败** | Fallback save error. |
| 🟡 | `regeneratingBusy` | Regenerating and merging — surviving nodes keep their mastery and history… | **正在重新生成并合并——留存下来的节点保有其掌握度与历史……** | Busy label during a rebuild, repeating the merge reassurance. |
| 🟡 | `regenerationFailedError` | regeneration failed | **重新生成失败** | Fallback rebuild error. |
| 🟢 | `masteryGridLabel` | Mastery grid | **掌握度网格** | Heading over the editable grid. |
| 🟢 | `trainButton` | Train | **训练** | Starts a session from this screen. |
| 🟢 | `regenerateAndMergeButton` | Regenerate & merge | **重新生成并合并** | Rebuilds the map from the existing material. |
| 🟢 | `cellInspectorHeading` | {title} · {depthShort} {depthName} | **{title} · {depthShort} {depthName}** | Heading of the panel that opens on clicking a grid cell. |
| 🟢 | `closeButton` | Close | **关闭** | Closes that panel. |
| 🟢 | `statEstimate` | Estimate | **估计值** | Cell statistic: the raw mastery estimate. |
| 🟢 | `statEffective` | Effective | **折算后** | Cell statistic: mastery after discounting for elapsed time. |
| 🟢 | `statRetrievability` | Retrievability | **可提取性** | Cell statistic: how much of what was learned is expected to survive right now. |
| 🟢 | `statResponses` | Responses | **作答次数** | Cell statistic: answers recorded for this cell. |
| 🟢 | `statInterval` | Interval | **间隔** | Cell statistic: the current gap between reviews. |
| 🟢 | `intervalDaysValue` | {days}d | **{days} 天** | The value for that statistic, in days. |
| 🟢 | `statNextDue` | Next due | **下次到期** | Cell statistic: when this cell comes back. |
| 🟢 | `markNotApplicableButton` | Mark not applicable | **标记为不适用** | Marks a cell meaningless at that depth, so it is never served. |
| 🟡 | `markApplicableButton` | Mark applicable | **标记为适用** | Reverses that. |
| 🟢 | `nodesLabel` | Nodes | **节点** | Heading over the editable node list. |
| 🟡 | `nodeTitleAriaLabel` | Title of node {index} | **第 {index} 个节点的标题** | Screen-reader name for a node-title field. |
| 🟢 | `nodeOriginGenerated` | generated | **生成** | Tag: this node was written by the model. |
| 🟢 | `nodeOriginUser` | user | **手动** | Tag: this node was written by hand. |
| 🟡 | `collapseButton` | Collapse | **收起** | Collapses an expanded node. |
| 🟢 | `misconceptionsToggle` | Misconceptions ({count}) | **误解（{count}）** | Opens the false-beliefs panel for a node. |
| 🟡 | `nodeDescriptionAriaLabel` | Description of {title} | **{title}的描述** | Screen-reader name for a node-description field. |
| 🟢 | `saveNodeButton` | Save | **保存** | Saves edits to a node. |
| 🟢 | `moveUpButton` | Move up | **上移** | Reorders a node upward. |
| 🟢 | `moveDownButton` | Move down | **下移** | Reorders it downward. |
| 🟢 | `deleteNodeButton` | Delete node | **删除节点** | Deletes a node. |
| 🟡 | `deleteNodeConfirm` | Delete "{title}"? Its cells, mastery estimates and response history go with it. This cannot be undone. | **删除「{title}」？它的单元、掌握度估计与作答记录都将一并消失。此举不可撤销。** | Confirmation before deleting. It must be unmistakable that mastery estimates and answer history go too, and that this cannot be undone. |
| 🟢 | `applicableDepths` | Applicable depths: {depths} | **适用深度：{depths}** | Label listing which depth levels apply to a node. |
| 🟡 | `applicableDepthsNone` | none | **无** | Shown when none do. |
| 🟡 | `misconceptionsPanelLabel` | Misconceptions — the distractor bank. Vagueness here degrades every item. | **误解——干扰项之库。此处含糊，每一道题都会因此变差。** | Heading over a node's false beliefs. The warning is load-bearing: wrong options are drawn from these, so vagueness here degrades every question on the node. |
| 🟡 | `misconceptionMeta` | {origin} · chosen {count}× | **{origin} · 被选 {count} 次** | Metadata under a false belief: where it came from, how often chosen. |
| 🟡 | `removeMisconceptionButton` | Remove | **移除** | Deletes one. |
| 🟡 | `misconceptionLabelPlaceholder` | Short handle, e.g. state ownership = social ownership | **简短的标签，如：国家所有制 = 社会所有制** | Placeholder for a short handle naming the belief. |
| 🟡 | `newMisconceptionLabelAriaLabel` | New misconception label | **新误解的标签** | Screen-reader name for that field. |
| 🟡 | `misconceptionDescriptionPlaceholder` | The belief in the first person, as a learner would hold it. | **以第一人称写出这一信念，一如学习者心中所持。** | Placeholder for the belief itself. It asks for first person, as the learner would hold it — that phrasing is what makes a wrong option tempting rather than obviously wrong. |
| 🟡 | `newMisconceptionDescriptionAriaLabel` | New misconception description | **新误解的描述** | Screen-reader name for that field. |
| 🟡 | `addMisconceptionButton` | Add misconception | **添加误解** | Adds the belief. |
| 🟢 | `addNodeByHandLabel` | Add a node by hand | **手动添加节点** | Heading over the add-a-node form. |
| 🟢 | `nodeTitlePlaceholder` | Node title | **节点标题** | Placeholder for a new node title. |
| 🟡 | `newNodeTitleAriaLabel` | New node title | **新节点的标题** | Screen-reader name for that field. |
| 🟢 | `nodeDescriptionPlaceholder` | What mastery of this node means — two to four sentences. | **掌握这个节点意味着什么——两到四句话。** | Placeholder for a new node description — what mastering it would mean. |
| 🟡 | `newNodeDescriptionAriaLabel` | New node description | **新节点的描述** | Screen-reader name for that field. |
| 🟢 | `addNodeButton` | Add node | **添加节点** | Adds the node. |

## Item health — 题目健康

*Statistics about the generated questions themselves.*

A diagnostic screen for the question bank, not the learner. Nearly every number here is qualified, because with a single test-taker classical item statistics are noisy — the hedges are the point, not decoration.

<sub>39 strings · 🟢 25 from the comp · 🟡 14 written to match</sub>

| | Key | English | 中文 | What it is for |
|---|---|---|---|---|
| 🟢 | `eyebrow` | Item health — the harness evaluating itself | **题目之健康——考具的自我考察** | Label above the concept name. |
| 🟢 | `statsAdvisory` | Single-user statistics are thin. Classical item analysis assumes many test-takers; with one person and a handful of administrations per item, difficulty and discrimination estimates are noisy. These are aggregated at the cell level, hidden below n&nbsp;=&nbsp;{minN}, and <strong>advisory only</strong> — do not read them as measurements. | **单人使用的统计量很薄。经典题目分析假定有大量应试者；只有一个人、每题又只施测数次时，难度与区分度的估计噪声很大。这些数字在单元层面汇总，n&nbsp;=&nbsp;{minN} 以下不予显示，且<strong>仅供参考</strong>——不要当作测量结果来读。** | The screen's central hedge. Classical item statistics assume many test-takers; with one person they are noisy, so these numbers are advisory and must not be read as measurements. |
| 🟢 | `perCellLabel` | Per cell | **按单元** | Heading over per-cell statistics. |
| 🟢 | `deadDistractorsLabel` | Dead distractors — never chosen across five or more administrations | **死干扰项——施测五次以上从未被选中** | Heading over wrong options nobody ever picks. |
| 🟡 | `deadDistractorsNoneYet` | None yet. | **尚无。** | Empty state for that list. |
| 🟢 | `deadDistractorsRationale` | A distractor nobody picks silently converts a 4-option item into a 3-option item and inflates the guess rate, so this list is worth clearing. | **从没被选过的干扰项会把四选一变成三选一，抬高猜对率，因此这份清单值得清理。** | Why they matter: an option nobody chooses silently turns a four-option question into a three-option one and inflates the chance of guessing right. |
| 🟢 | `distractorServedCount` | {count} served | **已施测 {count} 次** | How often a given wrong option was shown. |
| 🟢 | `validatorRejectionLabel` | Validator rejection rate by node | **按节点的校验器拒绝率** | Heading over questions the independent checker refused. |
| 🟢 | `validatorRejectionAdvisory` | A node above 30% is usually badly drawn rather than hard. The likeliest explanation for scattered failure is not several separate gaps but one node that was never properly cut. | **某个节点超过 30%，通常说明它划分得不好，而不是它难。零散的失败最可能的解释不是若干互不相关的缺口，而是一个从未被正确切开的节点。** | What a high rejection rate means: usually the map node is badly drawn, not that generation is broken. |
| 🟢 | `nodeRejectionSummary` | {rejected}/{generated} rejected · {rate} | **{rejected}/{generated} 被拒 · {rate}** | Per-node rejection rate. |
| 🟡 | `loadItemsError` | could not load items | **无法载入题目** | Fallback error loading the question list. |
| 🟡 | `actionFailedError` | action failed | **操作失败** | Fallback error for an action on this screen. |
| 🟡 | `noItemsForConcept` | No items generated yet for this concept. | **此概念尚未生成任何题目。** | Empty state when nothing has been generated yet. |
| 🟢 | `cellItemCountOne` | {count} item | **{count} 道题** | Singular question count for a cell. |
| 🟢 | `cellItemCountOther` | {count} items | **{count} 道题** | Plural question count. |
| 🟢 | `cellSampleSize` | n = {n} | **n = {n}** | Sample size behind a cell's statistics. |
| 🟢 | `statisticsWithheld` | statistics withheld below n = {minN} | **n = {minN} 以下不显示统计量** | Shown instead of a statistic when the sample is too small to mean anything. Withholding is deliberate — a number from three answers would be believed. |
| 🟢 | `cellDifficulty` | difficulty {value} | **难度 {value}** | Per-cell statistic: the share of answers that were correct. |
| 🟢 | `cellDiscrimination` | discrimination {value} | **区分度 {value}** | Per-cell statistic: how well the questions separate people who know the material from those who do not. |
| 🟢 | `advisoryTag` | (advisory) | **（仅供参考）** | Appended to a statistic to mark it as indicative rather than measured. |
| 🟡 | `hideItemsButton` | Hide | **收起** | Collapses them. |
| 🟢 | `showItemsButton` | Items | **题目** | Expands the questions for a cell. |
| 🟢 | `generateButton` | Generate | **生成** | Generates a fresh question for a cell on demand. |
| 🟡 | `noItemsForCell` | No items stored for this cell. | **此单元尚无题目。** | Empty state for one cell. |
| 🟢 | `itemIdLabel` | #{id} | **#{id}** | The internal question number, for referring to one. |
| 🟢 | `benchmarkBadge` | benchmark | **基准集** | Tag: this question belongs to the frozen measurement set. |
| 🟡 | `retiredBadge` | retired | **已停用** | Tag: withdrawn from use. |
| 🟡 | `rejectedByValidatorBadge` | rejected by validator | **已被校验器拒绝** | Tag: refused by the independent checker and never shown. |
| 🟢 | `itemServedCount` | served {count}× | **已施测 {count} 次** | How many times a question has been shown. |
| 🟢 | `optionChosenCount` | (chosen {count}×) | **（被选 {count} 次）** | How many times a particular option was picked. |
| 🟡 | `validatorFlags` | validator flags: {flags} | **校验器标记：{flags}** | The specific faults the checker raised. |
| 🟡 | `validatorFlagsNotesSuffix` |  — {notes} | **——{notes}** | Free-text remarks appended to those flags. |
| 🟡 | `promoteButtonTitleEnabled` | Freeze this item into the benchmark set. It leaves practice permanently. | **将此题冻结入基准集。自此永不入练习。** | Tooltip on the promote button: freezing a question into the benchmark set removes it from practice permanently. |
| 🟡 | `promoteButtonTitleDisabled` | Only validated items can join the benchmark set. | **只有通过校验的题目才能进入基准集。** | Tooltip when promotion is not allowed — only checked questions qualify. |
| 🟡 | `promoteButton` | Promote to benchmark | **升入基准集** | Promotes a question into the frozen set. |
| 🟢 | `demoteButton` | Return to practice | **退回练习池** | Takes a question back out of the frozen set and returns it to ordinary practice. |
| 🟡 | `unretireButton` | Un-retire | **取消停用** | Restores it. |
| 🟢 | `retireButton` | Retire | **停用** | Withdraws a question. |
| 🟢 | `conceptIdLabel` | Concept #{conceptId} | **概念 #{conceptId}** | The internal concept number. |

## Benchmark — 基准集

*A frozen, hand-vetted question set used for measurement.*

The distinction this screen exists to make: practise on generated questions, measure on frozen ones. Without a frozen set you cannot tell improvement from the generator drifting easier, and the copy has to carry that.

<sub>17 strings · 🟢 11 from the comp · 🟡 6 written to match</sub>

| | Key | English | 中文 | What it is for |
|---|---|---|---|---|
| 🟢 | `eyebrow` | The frozen set — the only honest measurement | **冻结之集——唯一诚实的度量** | Label above the concept name. |
| 🟢 | `lede` | Practice runs on items generated fresh every time, which is what stops you memorizing the card instead of knowing the concept — but it also means improvement and item drift are indistinguishable. These items are frozen, human-vetted, and never enter practice. A benchmark run shows no feedback until the whole run is finished. | **练习所用之题，每次皆新生成，故你所记住者是概念，不是卡片；然亦因此，进步与题目难易之游移无从分辨。此处之题，一经冻结、由人核验，永不入练习。基准测评一轮未毕，不示任何反馈。** | What the benchmark set is for: frozen, hand-vetted questions kept out of practice so that measurement is not contaminated by the same questions being trained on. |
| 🟢 | `runButton` | Run benchmark | **运行基准测评** | Starts a benchmark run. |
| 🟡 | `runButtonBusy` | Starting… | **正在开始……** | Busy label. |
| 🟢 | `promoteItemsLink` | Promote items to the set | **把题目升入基准集** | Link to where questions are promoted into the frozen set. |
| 🟡 | `emptySetWarning` | The frozen set is empty. Until it has items, nothing here can tell you whether you are improving or the generator merely got easier. Promote validated items from the item health screen. | **冻结之集尚空。集内没有题目，此处便无从判断：是你在进步，还是生成器只是把题出得容易了。请自题目健康一页，将已通过校验的题目升入此集。** | Shown when the set is empty. The argument matters: with nothing frozen, you cannot distinguish real improvement from the generator quietly producing easier questions. |
| 🟢 | `uncoveredWarningOne` | {count} node has no frozen item: {nodes}. The benchmark measures only what it covers. | **有 {count} 个节点还没有冻结题目：{nodes}。基准集只能度量它覆盖到的部分。** | Warning naming one sub-concept with nothing frozen. The closing clause is the point: a benchmark measures only what it covers, so gaps make the score narrower than it looks. |
| 🟢 | `uncoveredWarningOther` | {count} nodes have no frozen item: {nodes}. The benchmark measures only what it covers. | **有 {count} 个节点还没有冻结题目：{nodes}。基准集只能度量它覆盖到的部分。** | The same warning for several sub-concepts. |
| 🟢 | `coverageSectionLabel` | Per-node coverage of the frozen set | **基准集的按节点覆盖** | Heading over per-node coverage of the frozen set. |
| 🟢 | `coverageItemCountOne` | {count} item | **{count} 道题** | Singular count of frozen questions for a node. |
| 🟢 | `coverageItemCountOther` | {count} items | **{count} 道题** | Plural count. |
| 🟢 | `runHistorySectionLabel` | Run history | **运行历史** | Heading over past runs. |
| 🟡 | `noRunsYet` | No runs yet. | **尚未运行过。** | Empty state for that history. |
| 🟡 | `runBarTitle` | {date}: {percent}% | **{date}：{percent}%** | Tooltip on a run in the history chart. |
| 🟢 | `frozenItemsSectionLabel` | Frozen items ({count}) | **冻结题目（{count}）** | Heading over the frozen questions, with how many there are. |
| 🟡 | `frozenItemsEmpty` | Empty. | **尚空。** | Empty state for that list. |
| 🟡 | `runStartError` | could not start the run | **未能开始此次运行** | Fallback error if a run cannot start. |

## Login and registration — 登录与注册

*Signing in, and opening an account.*

Two states on one screen, toggled by the links at the bottom. It is the one place a reader may arrive unable to read the language, which is why the locale toggle is present here and not only inside the app. Almost all of it is new since the comp: it drew a single shared password, and the deployment now has real accounts.

<sub>28 strings · 🟢 1 from the comp · 🟡 27 written to match</sub>

| | Key | English | 中文 | What it is for |
|---|---|---|---|---|
| 🟡 | `eyebrow` | Γνῶθι σεαυτόν — but first, identify yourself | **Γνῶθι σεαυτόν——但请先表明身份** | Label above the heading. Γνῶθι σεαυτόν is "know thyself" and stays Greek, as in the comp; the joke is that the app wants identification first. |
| 🟡 | `headline` | The gym is {emphasis}. | **训练馆已{emphasis}。** | The heading. {emphasis} is the accented word. |
| 🟡 | `headlineEmphasis` | locked | **上锁** | The emphasised word in that heading. |
| 🟡 | `lede` | Your record follows the account, not the machine — sign in anywhere and the schedule is where you left it. | **你的记录跟随账户，而非设备——在任何地方登录，进度都在你离开的位置。** | The paragraph under the heading, and the reason to sign in rather than just start using it. The claim is portability: the record lives with the account, so the schedule survives changing machines. The comp said something else entirely here — it explained a shared password — because that is what the product had at the time. |
| 🟡 | `emailPlaceholder` | Email | **邮箱** | Placeholder in the email field. |
| 🟡 | `emailAriaLabel` | Email | **邮箱** | Screen-reader name for it. |
| 🟡 | `passwordPlaceholder` | Password | **密码** | Placeholder in the password field. |
| 🟡 | `passwordAriaLabel` | Password | **密码** | Screen-reader name for it. |
| 🟢 | `submitButton` | Enter | **进入** | Submits the sign-in form. |
| 🟡 | `submitButtonBusy` | Checking… | **正在核对……** | Busy label. |
| 🟡 | `signInFailedFallback` | could not sign in | **无法登录** | Fallback error on a failed attempt. |
| 🟡 | `toSignupPrompt` | No account yet? | **还没有账户？** | Prompt beside the link to registration. |
| 🟡 | `toSignupLink` | Create one | **创建一个** | The link itself. |
| 🟡 | `toLoginPrompt` | Already have an account? | **已经有账户？** | Prompt beside the link back to signing in. |
| 🟡 | `toLoginLink` | Sign in | **登录** | The link itself. |
| 🟡 | `signupEyebrow` | A record of your own | **属于你自己的记录** | Label above the registration heading. The point of an account is a record that belongs to you. |
| 🟡 | `signupHeadline` | Open an {emphasis}. | **开设一个{emphasis}。** | The registration heading. {emphasis} is the accented word. |
| 🟡 | `signupHeadlineEmphasis` | account | **账户** | The emphasised word in that heading. |
| 🟡 | `signupLede` | The blueprints and the item bank are shared; what you know is not. Concepts other people have mapped are yours to take up, with your own mastery starting at zero. | **蓝图与题库是共享的，你的掌握程度不是。他人已绘制的概念你可直接接手，而掌握度从零开始。** | The paragraph under the registration heading. Same two claims as the library note, made before the reader has an account: shared material, private record. It is the product’s answer to “why would I join rather than start my own?” |
| 🟡 | `codePlaceholder` | Registration code | **注册码** | Placeholder for the registration code that gates sign-up. |
| 🟡 | `codeAriaLabel` | Registration code | **注册码** | Screen-reader name for it. |
| 🟡 | `codeNote` | Generating items costs real money against this deployment’s API key, so signup is by code. Ask whoever runs it. | **生成题目会实际消耗本部署的 API 额度，因此注册需要邀请码。请向管理者索取。** | Explains why registration is gated at all. The honest reason is cost — every generated item spends against this deployment’s API key — and saying so is friendlier than an unexplained wall. It must not read as exclusivity; it must read as a bill someone is paying. Ends by telling the reader what to actually do: ask whoever runs the deployment. |
| 🟡 | `displayNamePlaceholder` | Name (optional) | **称呼（可选）** | Placeholder for an optional display name. |
| 🟡 | `displayNameAriaLabel` | Display name | **显示名称** | Screen-reader name for it. |
| 🟡 | `signupButton` | Create account | **创建账户** | Creates the account. |
| 🟡 | `signupButtonBusy` | Creating… | **正在创建……** | Busy label. |
| 🟡 | `signupFailedFallback` | could not create the account | **无法创建账户** | Fallback error if the account cannot be created. |
| 🟡 | `signOutButton` | Sign out | **退出登录** | Signs out. Sits in the header beside the account name. |

## Depth ladder — 深度层级

*D1–D6: the six levels every question is written to.*

The app's central vocabulary, surfaced on the session, dashboard and blueprint screens. These six definitions decide what every generated question is *for*, so they need to be exact rather than graceful. The D1–D6 codes stay Latin.

<sub>13 strings · 🟢 7 from the comp · 🟡 6 written to match</sub>

| | Key | English | 中文 | What it is for |
|---|---|---|---|---|
| 🟢 | `d1Name` | Recall | **回忆** | Level 1 name: repeating what was stated. |
| 🟡 | `d1Definition` | State the definition, components, or key claim from memory. | **凭记忆道出其定义、组成部分或关键论断。** | What a D1 question must ask for. |
| 🟢 | `d2Name` | Comprehension | **理解** | Level 2 name: understanding rather than repeating. |
| 🟡 | `d2Definition` | Recognize a correct restatement; identify the parts and how they relate. | **认出正确的复述；指出其各部分，以及彼此之间如何关联。** | What a D2 question must ask for. |
| 🟢 | `d3Name` | Application | **应用** | Level 3 name: using the idea. |
| 🟡 | `d3Definition` | Apply the concept to a case not seen before. | **将此概念用于前所未见的个案。** | What a D3 question must ask for. |
| 🟢 | `d4Name` | Boundary | **边界** | Level 4 name: where the idea stops holding. |
| 🟢 | `d4Definition` | Identify where the concept stops holding, its edge conditions and exceptions. | **指出此概念于何处不复成立：其边缘之条件与例外。** | What a D4 question must ask for. |
| 🟢 | `d5Name` | Discrimination | **辨析** | Level 5 name: telling it apart from its neighbours. |
| 🟡 | `d5Definition` | Distinguish it from its nearest confusable neighbors. | **将其与最邻近、最易相混的概念区分开来。** | What a D5 question must ask for — the hardest to write, because the wrong options have to be nearly right. |
| 🟢 | `d6Name` | Critique | **批判** | Level 6 name: judging the idea itself. |
| 🟡 | `d6Definition` | Steelman, find the flaw in a plausible misuse, state what would falsify it. | **为其立最强之说；在貌似合理的误用中找出破绽；说出什么能将其证伪。** | What a D6 question must ask for. D6 is written-answer only: recognition cannot test critique. |
| 🟡 | `unknownDepthLevel` | unknown depth level {level} | **未知的深度层级 {level}** | Internal fallback for an out-of-range level. Should never be seen. |

---

## Where to look hardest

If you have limited time, these carry the most meaning per word and would do the most damage if they read wrong:

1. **`session.confidencePrompt`** — 提交前——你有多确定？ The confidence question is the single most important interaction in the product. Four states matter: right-and-confident, right-and-guessing, wrong-and-unsure, wrong-and-confident. If this reads as an optional extra rather than part of answering, the student model degrades.
2. **`session.feedbackHeadWrong`** — 此番不中。 It must be a plain statement of fact. People have to be willing to be wrong in front of this screen many times a day.
3. **`session.dontKnow`** and **`session.dontKnowHint`** — the button that admits ignorance, and the line explaining what it costs. It has to read as a legitimate third answer, not as giving up. A learner who feels judged here will guess instead, and a lucky guess is the single most damaging thing that can enter the student model.
4. **`blueprint.lede`** — the argument that the map is fallible and editing it by hand is the intended workflow. If this reads as an apology for a broken feature, nobody will edit anything.
5. **`concepts.lede`** — the product's only self-description. The claim is that it does not lecture.
6. **`depth.*`** — six definitions that decide what every generated question is *for*. These need to be exact more than graceful.
7. **`items.statsAdvisory`** and **`dashboard.masteryGridLabel`** — deliberate hedges. Without them the numbers read as more solid than they are.
8. **`blueprint.redrawMergeNote`** and **`blueprint.deleteNodeConfirm`** — the two places a reader decides whether an irreversible-looking action is safe.

## How to report a change

Each row has a key like `session.confidencePrompt`. Send the key and the replacement Chinese; the tables live in `lib/i18n/dict.ts` and the English is never touched by a Chinese edit. A key present in English and missing in Chinese fails the build, so nothing can silently go blank.

