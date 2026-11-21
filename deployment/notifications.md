# 消息通知与微信订阅

## 本地构建与验证

在代码工作树根目录运行。

```powershell
node scripts/build-notifications.js
node --test tests/notifications.test.js
```

共享模块由构建脚本复制到各云函数的 `lib`。上传前执行构建，随后在微信开发者工具或 CloudBase 控制台部署聊天、报价、商品、通知接口和通知定时任务五个云函数并安装依赖。

## 测试环境准备

新增集合使用「仅管理员可读写」，由云函数按当前微信身份校验权限。

| 集合 | 用途和需要核对的索引 |
|---|---|
| `notifications` | 站内通知。核对 `ownerId ASC, createdAt DESC` 和 `ownerId ASC, read ASC`。允许保留已有通知。 |
| `notificationDeliveries` | 微信投递记录。核对 `state ASC, nextAt ASC` 和 `state ASC, leaseUntil ASC`。 |
| `notificationSubscriptions` | 按模板记录的单次授权与撤销标记。核对 `ownerId ASC, templateId ASC, state ASC, createdAt ASC`。 |
| `notificationTickets` | 短时授权请求记录。 |
| `notificationRequests` | 购买及更新请求的幂等记录。 |
| `notificationTasks` | 未选中、商品变化和面交提醒任务。核对 `state ASC, nextAt ASC` 和 `state ASC, leaseUntil ASC`。 |

核对现有集合索引。报价到期使用 `offers.status ASC, expiresAt ASC` 与 `offers.status ASC, createdAt ASC`。批量通知使用 `offers.goodsId ASC, status ASC, createdAt ASC`，必要时按控制台诊断补充排序索引。会话通过 `conversations.goodsId ASC, sellerId ASC, buyerId ASC, updatedAt DESC` 找到历史会话。聊天页读取最近消息使用 `messages.conversationId ASC, createdAt DESC`。

定时任务使用 `notification-minute`，按分钟执行。启用 `subscribeMessage.send` 云调用权限。保持该函数无公开 HTTP 路由，核对其运行上下文的 `TRIGGER_SRC` 或 `TCB_SOURCE`，以及相应触发日志。

## 微信模板配置

在微信公众平台取得当前小程序已批准的模板。将 [模板配置示例](notification-templates.example.json) 中的空 ID 和字段名替换为控制台的真实值，用同一份 JSON 设置 `notification` 与 `notification-worker` 的 `WECHAT_NOTIFICATION_TEMPLATES`。示例中的字段名仅展示形状，必须匹配实际模板。一个模板可对应多个审核批准范围内的事件。

| 字段来源 | 值 |
|---|---|
| `event` | 业务事件短标题。适用于语义匹配的 `thing` 或 `phrase`。 |
| `summary` | 固定业务摘要。适用于 `thing`。 |
| `time` | 上海时区的事件时间。适用于 `date` 或 `time`。 |
| `app` | 校园二手。适用于 `thing`。 |

消息、交易和治理事件键定义在共享通知模块。聊天包括 `chat.consult`、`chat.message`。申请包括 `offer.created`、`offer.bid`、`offer.updated`、`offer.withdrawn`、`offer.accepted`、`offer.unselected`、`offer.declined`、`offer.expired`。面交和商品变化包括 `trade.meetup`、`trade.meetup-confirmed`、`trade.cancelled`、`goods.sold`、`goods.off`、`goods.changed`。

设置 `notification-worker` 的 `WECHAT_NOTIFICATION_STATE`。测试用 `developer` 或 `trial`，正式小程序发布并包含通知路由后使用 `formal`。每次用户点击授权一个模板，为授权之后的对应业务事件预留一份发送额度。模板缺失、用户拒绝、额度用尽时仍可在通知中心查看。微信通知链接统一进入本人通知详情。

治理业务可在其授权后的数据库事务中调用共享模块的 `recordNotice(tx, { type, ownerId, source, createdAt })`。审核、举报、申诉分别使用 `moderation.result`、`report.result`、`appeal.result`。用治理决定编号作为 `source`。接口供服务端事务使用。

## 真机与运行验收

在独立环境使用两个已授权的微信测试账号，确保小程序初始化和云函数指向同一环境。验证以下各项。

1. 买家首次咨询、重复进入、提交购买申请和发送聊天回复，核对卖家通知、会话卡片和未读数。
2. 让买卖双方各做一轮授权和拒绝。对两次符合条件的新业务事件检查一次性额度。关闭小程序后验证可收到微信服务通知，并能点击打开本人通知和相关会话。
3. 验证报价更新、拒绝、未选中、到期、书况、售出和下架。未选中的买家只看到本人结果。查阅首次面交到期任务与解锁操作。
4. 用测试投递响应验证重试和结果不确定的记录。明确失败可重试，网络超时处于结果不确定时只保留记录以供核对。

运行后监控待发送记录、失败的交易任务和最近错误码。回退时可先暂停通知定时触发，保留站内记录及已消费授权历史，避免重放微信通知。当前交付包含模板配置与本地模拟验收，实际模板批准和真机接收以独立环境验证为准。
