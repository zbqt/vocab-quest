/*!
 * 长对话听写题库
 *
 * 选材原则：
 * 1. 只收「听得出来」的句子 —— 词都常见，难点在连读、弱读、语速，不在生词。
 *    听写被生词卡住，练的是猜词不是听力。
 * 2. 每句 6~15 词。超过 15 词一句，人记不住，只会不停重播。
 * 3. 全部是考试里真会出现的场景：校园、租房、兼职、面试、看病、改签。
 * 4. 每句给中文，但只在「看提示」时出现 —— 它是兜底，不是拐杖。
 *
 * level 1 日常 / 2 校园生活 / 3 稍难（面试、学术、突发状况）
 */
const DIALOGUES = [
  {
    id: "cafe", title: "咖啡店点单", scene: "日常", level: 1,
    lines: [
      { sp: "A", en: "Good morning. What can I get for you today?", zh: "早上好，今天想喝点什么？" },
      { sp: "B", en: "I'd like a medium coffee, please, with a little milk.", zh: "我要一杯中杯咖啡，加一点牛奶。" },
      { sp: "A", en: "Sure. Would you like anything to eat with that?", zh: "好的。要不要配点吃的？" },
      { sp: "B", en: "Yes, do you have any sandwiches left?", zh: "要，你们还有三明治吗？" },
      { sp: "A", en: "We have chicken and cheese. Which one would you like?", zh: "有鸡肉的和奶酪的，您要哪个？" },
      { sp: "B", en: "The cheese one, please. How much is that in total?", zh: "奶酪的。一共多少钱？" }
    ]
  },
  {
    id: "directions", title: "问路去图书馆", scene: "日常", level: 1,
    lines: [
      { sp: "A", en: "Excuse me, could you tell me how to get to the library?", zh: "打扰一下，能告诉我去图书馆怎么走吗？" },
      { sp: "B", en: "Sure. Go straight down this road and turn left at the bank.", zh: "沿这条路直走，到银行左转。" },
      { sp: "A", en: "Is it far from here?", zh: "离这儿远吗？" },
      { sp: "B", en: "Not really. It takes about five minutes on foot.", zh: "不远，走路大概五分钟。" },
      { sp: "A", en: "Thanks a lot. Is it open on Sunday?", zh: "多谢。周日开门吗？" },
      { sp: "B", en: "Yes, but it closes early, at four in the afternoon.", zh: "开，但关得早，下午四点就关。" }
    ]
  },
  {
    id: "weekend", title: "周末计划", scene: "日常", level: 1,
    lines: [
      { sp: "A", en: "What are you going to do this weekend?", zh: "这周末你打算干什么？" },
      { sp: "B", en: "I'm not sure yet. Maybe I'll go hiking if the weather is good.", zh: "还没定。天气好的话可能去爬山。" },
      { sp: "A", en: "The forecast says it will rain on Saturday.", zh: "预报说周六下雨。" },
      { sp: "B", en: "Then I'll probably stay at home and watch a movie.", zh: "那我大概就在家看电影了。" },
      { sp: "A", en: "You could come over. I just got a new projector.", zh: "你可以来我这儿，我刚买了个投影仪。" },
      { sp: "B", en: "That sounds great. I'll bring some snacks.", zh: "太好了，我带点零食。" }
    ]
  },
  {
    id: "courses", title: "开学选课", scene: "校园", level: 2,
    lines: [
      { sp: "A", en: "Have you decided which courses to take this semester?", zh: "这学期选什么课你定了吗？" },
      { sp: "B", en: "I'm thinking about economics, but the reading list looks heavy.", zh: "我在考虑经济学，但书单看着挺重。" },
      { sp: "A", en: "You should talk to the professor before you register.", zh: "注册前你应该先跟教授聊聊。" },
      { sp: "B", en: "Do you know when the deadline is?", zh: "你知道截止日期是什么时候吗？" },
      { sp: "A", en: "I think it's the end of this week, so you'd better hurry.", zh: "应该是这周末，你最好抓紧。" },
      { sp: "B", en: "Thanks. I'll send him an email tonight.", zh: "谢了，我今晚给他发邮件。" }
    ]
  },
  {
    id: "library", title: "还书逾期", scene: "校园", level: 2,
    lines: [
      { sp: "A", en: "I'd like to return these two books, but I think they're late.", zh: "我想还这两本书，但好像逾期了。" },
      { sp: "B", en: "Let me check. Yes, they were due last Friday.", zh: "我查一下。是的，上周五到期。" },
      { sp: "A", en: "I'm sorry. I was sick and couldn't come to campus.", zh: "抱歉，我生病了，来不了学校。" },
      { sp: "B", en: "I understand, but there is a small fine for each day.", zh: "我理解，不过每天有一点罚金。" },
      { sp: "A", en: "How much do I owe you?", zh: "我一共要交多少？" },
      { sp: "B", en: "Two dollars in total. You can pay at the front desk.", zh: "一共两美元，在服务台交就行。" }
    ]
  },
  {
    id: "apartment", title: "打电话问租房", scene: "生活", level: 2,
    lines: [
      { sp: "A", en: "Hi, I'm calling about the apartment you advertised online.", zh: "你好，我打电话问一下你们网上登的那套房子。" },
      { sp: "B", en: "It's still available. It has two bedrooms and a small kitchen.", zh: "还在。两个卧室，一个小厨房。" },
      { sp: "A", en: "How much is the rent, and does it include water and electricity?", zh: "房租多少？包水电吗？" },
      { sp: "B", en: "The rent is eight hundred a month, and water is included.", zh: "月租八百，水费包含在内。" },
      { sp: "A", en: "Is it close to the subway station?", zh: "离地铁站近吗？" },
      { sp: "B", en: "About ten minutes' walk. Would you like to see it tomorrow?", zh: "走路十分钟左右。明天想来看吗？" }
    ]
  },
  {
    id: "dorm", title: "宿舍停暖", scene: "生活", level: 2,
    lines: [
      { sp: "A", en: "Did you hear that the heating in our building will be off tomorrow?", zh: "你听说咱们楼明天停暖了吗？" },
      { sp: "B", en: "Again? This is the third time this month.", zh: "又停？这个月第三次了。" },
      { sp: "A", en: "They said they need to repair the pipes.", zh: "他们说管道要修。" },
      { sp: "B", en: "I'll borrow an extra blanket from my neighbor.", zh: "我去跟邻居多借条毯子。" },
      { sp: "A", en: "Good idea. I'll also buy a small heater this afternoon.", zh: "好主意。我下午也去买个小暖风机。" },
      { sp: "B", en: "Be careful. The dorm doesn't allow anything too powerful.", zh: "小心点，宿舍不让用功率太大的。" }
    ]
  },
  {
    id: "parttime", title: "找校内兼职", scene: "校园", level: 2,
    lines: [
      { sp: "A", en: "I saw a notice about a part-time job in the student center.", zh: "我在学生中心看到一则兼职招聘。" },
      { sp: "B", en: "What kind of job is it?", zh: "什么工作？" },
      { sp: "A", en: "Helping international students with registration, twice a week.", zh: "帮留学生办理注册，一周两次。" },
      { sp: "B", en: "Do they require any experience?", zh: "要求有经验吗？" },
      { sp: "A", en: "They said good English is enough, and they'll train you.", zh: "他们说英语好就行，会培训。" },
      { sp: "B", en: "That sounds perfect for me. Where do I apply?", zh: "这太适合我了。去哪儿报名？" }
    ]
  },
  {
    id: "interview", title: "实习面试", scene: "求职", level: 3,
    lines: [
      { sp: "A", en: "Tell me a little about why you applied for this internship.", zh: "说说你为什么申请这个实习。" },
      { sp: "B", en: "I've been following your company's work on renewable energy.", zh: "我一直在关注贵公司在可再生能源方面的工作。" },
      { sp: "A", en: "What do you think you could contribute to the team?", zh: "你觉得自己能给团队带来什么？" },
      { sp: "B", en: "I'm good at data analysis, and I learn new tools quickly.", zh: "我擅长数据分析，学新工具也快。" },
      { sp: "A", en: "Have you worked on any project that required teamwork?", zh: "你做过需要团队合作的项目吗？" },
      { sp: "B", en: "Yes, last summer I helped organize a campus survey with five classmates.", zh: "做过，去年夏天我和五个同学一起做了校园调查。" }
    ]
  },
  {
    id: "groupwork", title: "小组作业分工", scene: "校园", level: 3,
    lines: [
      { sp: "A", en: "We need to finish the group report by Friday, and we're behind.", zh: "小组报告周五要交，我们进度落后了。" },
      { sp: "B", en: "I know. I've only written the introduction so far.", zh: "我知道，我到目前只写了引言。" },
      { sp: "A", en: "Let's divide the rest. Could you take the data section?", zh: "剩下的分一下。你写数据部分行吗？" },
      { sp: "B", en: "I can, but I'll need the numbers from the survey.", zh: "可以，但我需要问卷的数据。" },
      { sp: "A", en: "I'll send them tonight. Who will check the references?", zh: "我今晚发你。谁核对参考文献？" },
      { sp: "B", en: "Maybe Lisa. She's careful about details like that.", zh: "让 Lisa 吧，她对这些细节很仔细。" }
    ]
  },
  {
    id: "doctor", title: "校医院看病", scene: "生活", level: 3,
    lines: [
      { sp: "A", en: "What seems to be the problem?", zh: "哪里不舒服？" },
      { sp: "B", en: "I've had a sore throat and a headache since Monday.", zh: "从周一开始我嗓子疼、头疼。" },
      { sp: "A", en: "Do you have a fever?", zh: "发烧吗？" },
      { sp: "B", en: "I took my temperature this morning, and it was thirty eight degrees.", zh: "早上量了，三十八度。" },
      { sp: "A", en: "Let me have a look. You should rest and drink plenty of water.", zh: "我看一下。你要休息，多喝水。" },
      { sp: "B", en: "Should I take any medicine?", zh: "要吃点什么药吗？" },
      { sp: "A", en: "I'll write you a prescription. Come back if it gets worse.", zh: "我给你开个处方。加重了再来。" }
    ]
  },
  {
    id: "flight", title: "机场改签", scene: "出行", level: 3,
    lines: [
      { sp: "A", en: "I'm afraid my flight to Shanghai has been delayed by three hours.", zh: "我飞上海的航班好像延误了三小时。" },
      { sp: "B", en: "I'm sorry about that. Would you like to change to an earlier flight?", zh: "很抱歉，您想改到早一点的航班吗？" },
      { sp: "A", en: "Is there one this afternoon?", zh: "下午有吗？" },
      { sp: "B", en: "There's one at two thirty, but it's almost full.", zh: "两点半有一班，但快满了。" },
      { sp: "A", en: "I'll take it if there's a seat available.", zh: "有座位我就要。" },
      { sp: "B", en: "Let me check. Yes, I can move you, but there's a change fee.", zh: "我查一下。可以改，但有改签费。" },
      { sp: "A", en: "That's fine. I really need to be there tonight.", zh: "没问题，我今晚必须到。" }
    ]
  }
];

if (typeof module === "object" && module.exports) module.exports = DIALOGUES;
