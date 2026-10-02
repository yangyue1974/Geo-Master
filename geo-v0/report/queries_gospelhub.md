# GospelHub — GEO 题库

| | |
|---|---|
| 目标域 | `gospelhub.love` |
| 题量 | 115 |
| 指纹 | `63d00b24df192921` |
| 生成于 | 2026-10-02 |

> **这份题库已冻结。** 基线与所有复测必须用同一份文件 —— 评分与 diff 在指纹不匹配时会拒绝运行。改题库等于作废已有基线。

> 所有题目由模板 + 库内确凿事实确定性填充,没有一个专有名词是模型生成的。事实不足的模板不出题 —— 所以某些档位的题量低于配额,那是正确行为:少出题好过出假题。

## 构成

| 档 | 题数 | 模板分布 |
|---|---:|---|
| **control** | 20 | who-is 20 |
| **detail** | 50 | concert-venue 23 · release 23 · chronology 4 |
| **aggregate** | 15 | concerts-city 10 · concerts-month 4 · year-list 1 |
| **fresh** | 30 | artist-touring 14 · latest 13 · new-releases 3 |

其中 **13 道时间窗口题**("本月新发行"这类)在不同轮次问的不是同一件事 —— 题面字符串冻结了,语义没有。它们照跑照记录,但不并入主对比表。

## control 档(20 题)

对照组。实体主题目(Who is X),预期输给维基百科 —— 它的真正作用是检测引擎自身的漂移:control 档修复量为零,对手结构若在复测间大幅变化,说明引擎变了,其他档的变化就不能归因于修复。

### who-is — 20 题
<sub>Who is {artist}?</sub>

| qid | 题目 | 时效性 | 依据(库内事实) |
|---|---|---|---|
| `q001` | Who is Stephen Stanley? | none | — |
| `q002` | Who is Brandon Lake? | none | — |
| `q003` | Who is Hannah McClure? | none | — |
| `q004` | Who is NF? | none | — |
| `q005` | Who is Jervis Campbell? | none | — |
| `q006` | Who is The Red Clay Strays? | none | — |
| `q007` | Who is Maverick City Music? | none | — |
| `q008` | Who is Patrick Mayberry? | none | — |
| `q009` | Who is Ellie Holcomb? | none | — |
| `q010` | Who is MercyMe? | none | — |
| `q011` | Who is Darlene Zschech? | none | — |
| `q012` | Who is AOH Music? | none | — |
| `q013` | Who is NONAH? | none | — |
| `q014` | Who is Love & The Outcome? | none | — |
| `q015` | Who is Jesus Culture? | none | — |
| `q016` | Who is Brooke Ligertwood? | none | — |
| `q017` | Who is Bella Taylor Smith? | none | — |
| `q018` | Who is Crowder? | none | — |
| `q019` | Who is Jenn Johnson? | none | — |
| `q020` | Who is Brian & Jenn Johnson? | none | — |

## detail 档(50 题)

结构细节题。发行日期、专辑序列、某歌手在某城市的演出场馆 —— 维基条目在这一层普遍稀疏,结构化数据库是天然更好的来源。

### concert-venue — 23 题
<sub>{artist} 在 {city} 的演出场馆</sub>

| qid | 题目 | 时效性 | 依据(库内事实) |
|---|---|---|---|
| `q022` | Which venue is Passion playing at in Arlington, TX? | entity-relative | artist=Passion; city=Arlington, TX; expectedVenue=Globe Life Field; date=2026-12-31 |
| `q025` | Which venue is Blessing Offor playing at in San Antonio, TX? | entity-relative | artist=Blessing Offor; city=San Antonio, TX; expectedVenue=Paper Tiger; date=2026-10-21 |
| `q028` | Which venue is Zach Williams playing at in Duluth, MN? | entity-relative | artist=Zach Williams; city=Duluth, MN; expectedVenue=DECC Symphony Hall; date=2026-10-29 |
| `q031` | Which venue is Tauren Wells playing at in Lubbock, TX? | entity-relative | artist=Tauren Wells; city=Lubbock, TX; expectedVenue=Helen DeVitt Jones Theater, Buddy Holly Hall; date=2026-10-27 |
| `q033` | Which venue is Zach Williams playing at in Bloomington, IN? | entity-relative | artist=Zach Williams; city=Bloomington, IN; expectedVenue=Indiana University Auditorium; date=2026-10-23 |
| `q035` | Which venue is TobyMac playing at in Evansville, IN? | entity-relative | artist=TobyMac; city=Evansville, IN; expectedVenue=Ford Center; date=2026-11-06 |
| `q037` | Which venue is Bethel Music playing at in New York? | entity-relative | artist=Bethel Music; city=New York; expectedVenue=Irving Plaza; date=2026-10-17 |
| `q039` | Which venue is Zach Williams playing at in Longview, TX? | entity-relative | artist=Zach Williams; city=Longview, TX; expectedVenue=LeTourneau University Belcher Center; date=2026-11-05 |
| `q041` | Which venue is Phil Wickham playing at in Anaheim? | entity-relative | artist=Phil Wickham; city=Anaheim; expectedVenue=Honda Center; date=2026-10-15 |
| `q043` | Which venue is TobyMac playing at in Des Moines, IA? | entity-relative | artist=TobyMac; city=Des Moines, IA; expectedVenue=Casey's Center; date=2026-11-19 |
| `q045` | Which venue is Blessing Offor playing at in San Francisco, CA? | entity-relative | artist=Blessing Offor; city=San Francisco, CA; expectedVenue=Cafe du Nord; date=2026-10-25 |
| `q047` | Which venue is Tauren Wells playing at in Louisville, KY? | entity-relative | artist=Tauren Wells; city=Louisville, KY; expectedVenue=The Louisville Palace; date=2026-10-16 |
| `q049` | Which venue is Zach Williams playing at in Evans, GA? | entity-relative | artist=Zach Williams; city=Evans, GA; expectedVenue=Columbia County Performing Arts Center; date=2026-11-13 |
| `q051` | Which venue is Zach Williams playing at in Evansville, IN? | entity-relative | artist=Zach Williams; city=Evansville, IN; expectedVenue=Old National Events Plaza; date=2026-10-17 |
| `q053` | Which venue is Charity Gayle playing at in Cleveland, OH? | entity-relative | artist=Charity Gayle; city=Cleveland, OH; expectedVenue=Wolstein Center at CSU; date=2026-10-15 |
| `q055` | Which venue is Zach Williams playing at in Knoxville, TN? | entity-relative | artist=Zach Williams; city=Knoxville, TN; expectedVenue=Knoxville Civic Auditorium and Coliseum; date=2026-10-15 |
| `q057` | Which venue is TobyMac playing at in Sioux Falls, SD? | entity-relative | artist=TobyMac; city=Sioux Falls, SD; expectedVenue=Denny Sanford PREMIER Center; date=2027-03-16 |
| `q059` | Which venue is Tauren Wells playing at in Spokane, WA? | entity-relative | artist=Tauren Wells; city=Spokane, WA; expectedVenue=First Interstate Center for the Arts; date=2026-11-04 |
| `q061` | Which venue is Chandler Moore playing at in Columbia, SC? | entity-relative | artist=Chandler Moore; city=Columbia, SC; expectedVenue=Colonial Life Arena; date=2026-10-08 |
| `q063` | Which venue is Natalie Grant playing at in Tampa, FL? | entity-relative | artist=Natalie Grant; city=Tampa, FL; expectedVenue=Benchmark International Arena; date=2026-10-22 |
| `q065` | Which venue is Tauren Wells playing at in Dayton, OH? | entity-relative | artist=Tauren Wells; city=Dayton, OH; expectedVenue=Christian Life Center; date=2026-10-22 |
| `q067` | Which venue is Tauren Wells playing at in Frederick, MD? | entity-relative | artist=Tauren Wells; city=Frederick, MD; expectedVenue=International Community Church; date=2026-10-10 |
| `q069` | Which venue is We Are Messengers playing at in Pace, FL? | entity-relative | artist=We Are Messengers; city=Pace, FL; expectedVenue=Immanuel Baptist Church; date=2026-10-11 |

### release — 23 题
<sub>{album} 的发行日期</sub>

| qid | 题目 | 时效性 | 依据(库内事实) |
|---|---|---|---|
| `q023` | When was the album Faith Hope Love by We Are Messengers released? | none | album=Faith Hope Love; artist=We Are Messengers; expectedDate=2026-02-06 |
| `q026` | When was the album House of Worship by Lakewood Music released? | none | album=House of Worship; artist=Lakewood Music; expectedDate=2026-03-20 |
| `q029` | When was the album THIS CANNOT BE SOLD by KB released? | none | album=THIS CANNOT BE SOLD; artist=KB; expectedDate=2026-07-10 |
| `q032` | When was the album So Long by Peter Burton released? | none | album=So Long; artist=Peter Burton; expectedDate=2026-04-24 |
| `q034` | When was the album Mad At God by Jenn Johnson released? | none | album=Mad At God; artist=Jenn Johnson; expectedDate=2026-04-03 |
| `q036` | When was the album Moonlight by Chelsea Plank released? | none | album=Moonlight; artist=Chelsea Plank; expectedDate=2026-05-01 |
| `q038` | When was the album Break Open (Live) by Pat Barrett released? | none | album=Break Open (Live); artist=Pat Barrett; expectedDate=2026-03-13 |
| `q040` | When was the album Sparrow by Love & The Outcome released? | none | album=Sparrow; artist=Love & The Outcome; expectedDate=2026-03-13 |
| `q042` | When was the album Closer (Live in Chicago) by Jonathan McReynolds released? | none | album=Closer (Live in Chicago); artist=Jonathan McReynolds; expectedDate=2026-03-27 |
| `q044` | When was the album The Reminder (Deluxe) by TAYA released? | none | album=The Reminder (Deluxe); artist=TAYA; expectedDate=2026-04-24 |
| `q046` | When was the album DAY by Jonathan Ogden released? | none | album=DAY; artist=Jonathan Ogden; expectedDate=2026-03-14 |
| `q048` | When was the album Just That Good (Live From Passion 2026) by Passion released? | none | album=Just That Good (Live From Passion 2026); artist=Passion; expectedDate=2026-03-21 |
| `q050` | When was the album breakups with best friends by Zoe Levert released? | none | album=breakups with best friends; artist=Zoe Levert; expectedDate=2026-04-17 |
| `q052` | When was the album COULD BE TONIGHT by Hulvey released? | none | album=COULD BE TONIGHT; artist=Hulvey; expectedDate=2026-04-17 |
| `q054` | When was the album Here Comes the Wind by Travis Greene released? | none | album=Here Comes the Wind; artist=Travis Greene; expectedDate=2026-05-01 |
| `q056` | When was the album Live From Liberty University by Meredith Andrews released? | none | album=Live From Liberty University; artist=Meredith Andrews; expectedDate=2026-04-03 |
| `q058` | When was the album Good by Matthew West released? | none | album=Good; artist=Matthew West; expectedDate=2026-01-09 |
| `q060` | When was the album Change - EP by Stephen Stanley released? | none | album=Change - EP; artist=Stephen Stanley; expectedDate=2026-05-08 |
| `q062` | When was the album EAT by Brooke Ligertwood released? | none | album=EAT; artist=Brooke Ligertwood; expectedDate=2026-05-15 |
| `q064` | When was the album Jesus Is King by Matthew West released? | none | album=Jesus Is King; artist=Matthew West; expectedDate=2026-04-17 |
| `q066` | When was the album The Long Surrender by NEEDTOBREATHE released? | none | album=The Long Surrender; artist=NEEDTOBREATHE; expectedDate=2026-03-28 |
| `q068` | When was the album BEHOLD (Acoustic Live), Vol. 2 by AOH Music released? | none | album=BEHOLD (Acoustic Live), Vol. 2; artist=AOH Music; expectedDate=2026-02-27 |
| `q070` | When was the album You Lift Me Up by Phil King released? | none | album=You Lift Me Up; artist=Phil King; expectedDate=2026-07-17 |

### chronology — 4 题
<sub>{artist} 的专辑按时间排序</sub>

| qid | 题目 | 时效性 | 依据(库内事实) |
|---|---|---|---|
| `q021` | List Brandon Lake's albums in chronological order. | none | artist=Brandon Lake; knownAlbums=4 |
| `q024` | List Matthew West's albums in chronological order. | none | artist=Matthew West; knownAlbums=2 |
| `q027` | List We The Kingdom's albums in chronological order. | none | artist=We The Kingdom; knownAlbums=2 |
| `q030` | List Tauren Wells's albums in chronological order. | none | artist=Tauren Wells; knownAlbums=2 |

## aggregate 档(15 题)

跨实体聚合题。没有任何一个百科页面能回答,引擎必须引用一个现成的列表页。这一档是修复包的主战场。

### concerts-city — 10 题
<sub>{city} 有哪些即将到来的演出</sub>

| qid | 题目 | 时效性 | 依据(库内事实) |
|---|---|---|---|
| `q072` | What gospel concerts are coming up in Cleveland, OH? | window | city=Cleveland, OH; knownConcerts=3 |
| `q073` | What gospel concerts are coming up in Atlanta, GA? | window | city=Atlanta, GA; knownConcerts=3 |
| `q074` | What gospel concerts are coming up in San Antonio, TX? | window | city=San Antonio, TX; knownConcerts=3 |
| `q075` | What gospel concerts are coming up in Arlington, TX? | window | city=Arlington, TX; knownConcerts=3 |
| `q076` | What gospel concerts are coming up in Tampa, FL? | window | city=Tampa, FL; knownConcerts=2 |
| `q077` | What gospel concerts are coming up in Cincinnati, OH? | window | city=Cincinnati, OH; knownConcerts=2 |
| `q078` | What gospel concerts are coming up in Tulsa, OK? | window | city=Tulsa, OK; knownConcerts=2 |
| `q079` | What gospel concerts are coming up in Peoria, IL? | window | city=Peoria, IL; knownConcerts=2 |
| `q080` | What gospel concerts are coming up in Lubbock, TX? | window | city=Lubbock, TX; knownConcerts=2 |
| `q081` | What gospel concerts are coming up in Evansville, IN? | window | city=Evansville, IN; knownConcerts=2 |

### concerts-month — 4 题
<sub>{month} 有哪些演出</sub>

| qid | 题目 | 时效性 | 依据(库内事实) |
|---|---|---|---|
| `q082` | What gospel concerts are happening in October 2026? | none | month=2026-10; knownConcerts=52 |
| `q083` | What gospel concerts are happening in November 2026? | none | month=2026-11; knownConcerts=15 |
| `q084` | What gospel concerts are happening in December 2026? | none | month=2026-12; knownConcerts=3 |
| `q085` | What gospel concerts are happening in February 2027? | none | month=2027-02; knownConcerts=2 |

### year-list — 1 题
<sub>某年发行了哪些专辑</sub>

| qid | 题目 | 时效性 | 依据(库内事实) |
|---|---|---|---|
| `q071` | What gospel albums came out in 2026? | none | year=2026 |

## fresh 档(30 题)

时效题。未来的演出与近期发行 —— 百科天然滞后,活跃维护的数据库在这一档优势最大。

### artist-touring — 14 题
<sub>{artist} 接下来在哪演出</sub>

| qid | 题目 | 时效性 | 依据(库内事实) |
|---|---|---|---|
| `q086` | Where is Tauren Wells playing live next? | entity-relative | artist=Tauren Wells; knownUpcoming=15 |
| `q089` | Where is Elevation Worship playing live next? | entity-relative | artist=Elevation Worship; knownUpcoming=2 |
| `q092` | Where is TobyMac playing live next? | entity-relative | artist=TobyMac; knownUpcoming=6 |
| `q095` | Where is Phil Wickham playing live next? | entity-relative | artist=Phil Wickham; knownUpcoming=2 |
| `q097` | Where is Blessing Offor playing live next? | entity-relative | artist=Blessing Offor; knownUpcoming=8 |
| `q099` | Where is KB playing live next? | entity-relative | artist=KB; knownUpcoming=1 |
| `q101` | Where is Passion playing live next? | entity-relative | artist=Passion; knownUpcoming=5 |
| `q103` | Where is Charity Gayle playing live next? | entity-relative | artist=Charity Gayle; knownUpcoming=9 |
| `q105` | Where is Natalie Grant playing live next? | entity-relative | artist=Natalie Grant; knownUpcoming=1 |
| `q107` | Where is We Are Messengers playing live next? | entity-relative | artist=We Are Messengers; knownUpcoming=2 |
| `q109` | Where is Bethel Music playing live next? | entity-relative | artist=Bethel Music; knownUpcoming=2 |
| `q111` | Where is Tye Tribbett playing live next? | entity-relative | artist=Tye Tribbett; knownUpcoming=1 |
| `q113` | Where is Zach Williams playing live next? | entity-relative | artist=Zach Williams; knownUpcoming=14 |
| `q115` | Where is Chandler Moore playing live next? | entity-relative | artist=Chandler Moore; knownUpcoming=6 |

### latest — 13 题
<sub>{artist} 的最新单曲 / 专辑</sub>

| qid | 题目 | 时效性 | 依据(库内事实) |
|---|---|---|---|
| `q087` | What is Olivia Lane's latest single or album? | entity-relative | artist=Olivia Lane |
| `q090` | What is Kutless's latest single or album? | entity-relative | artist=Kutless |
| `q093` | What is The Belonging Co's latest single or album? | entity-relative | artist=The Belonging Co |
| `q096` | What is Francesca Battistelli's latest single or album? | entity-relative | artist=Francesca Battistelli |
| `q098` | What is Jeremy Riddle's latest single or album? | entity-relative | artist=Jeremy Riddle |
| `q100` | What is Chris Tomlin's latest single or album? | entity-relative | artist=Chris Tomlin |
| `q102` | What is TobyMac's latest single or album? | entity-relative | artist=TobyMac |
| `q104` | What is Hillsong Worship's latest single or album? | entity-relative | artist=Hillsong Worship |
| `q106` | What is SEU Worship's latest single or album? | entity-relative | artist=SEU Worship |
| `q108` | What is Austin French's latest single or album? | entity-relative | artist=Austin French |
| `q110` | What is We The Kingdom's latest single or album? | entity-relative | artist=We The Kingdom |
| `q112` | What is NF's latest single or album? | entity-relative | artist=NF |
| `q114` | What is Skillet's latest single or album? | entity-relative | artist=Skillet |

### new-releases — 3 题
<sub>本月 / 近期新发行</sub>

| qid | 题目 | 时效性 | 依据(库内事实) |
|---|---|---|---|
| `q088` | What are the new gospel releases this month? | window | — |
| `q091` | What gospel albums came out recently? | window | — |
| `q094` | Any new gospel music released in the last few weeks? | window | — |

## 字段说明

**时效性** —— spec 原文没有这一层,但 fresh 档必须拆,否则复测对比无效:

- `none` — 与时间无关,前后完全可比
- `entity-relative` — 实体固定、语义随时间推进,前后仍可比
- `window` — 时间窗口题 —— 不同轮次问的不是同一件事,**不并入主对比表**

**依据** —— 生成这道题所用的库内事实。用途是事后审计:每个专有名词都能在 `entities.json` 里找到出处,所以不存在"问了一首不存在的歌"这种废题。
