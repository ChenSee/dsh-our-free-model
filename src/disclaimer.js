/**
 * The disclaimer copy both surfaces show: the plugin's settings page and the
 * standalone/desktop console.
 *
 * ⚠️ 本 fork 的立场与上游不同：上游 2.7.x 起把 WorkBuddy 国内版、国际版与
 * 华为云整体移除并写了「不提供这三个渠道」的声明。本 fork 保留这三个渠道，
 * 因此文案改为说明「渠道按原样提供、凭据与合规由使用者自负」，不再声明排除。
 *
 * The copy is data, not markup: each surface renders it in its own idiom, so
 * there is exactly one place to change what the product says. It is deliberately
 * short — a wall of legal text is read by nobody — and states the project's
 * purpose plainly, because that is the honest description of what it is.
 */

export const DISCLAIMER_VERSION = 3

/** Channels this build does not offer, named for the reader. */
export const EXCLUDED_CHANNELS = Object.freeze([])

export const DISCLAIMER = Object.freeze({
  version: DISCLAIMER_VERSION,
  title: '使用须知与免责声明',
  subtitle: '关于渠道来源，以及你需要知道的责任边界',
  intro: '本插件是一个个人学习与技术研究项目，用于学习模型网关、协议适配与本地路由的实现方式，按「现状」提供，不构成任何商业服务或产品承诺。',
  sections: Object.freeze([
    {
      id: 'third-party',
      heading: '渠道来自各家服务商，与本项目无隶属关系',
      body: '本插件接入的账号渠道（包括 WorkBuddy 国内版与国际版、华为云 CodeArts，以及 LobsterAI、Qoder、TRAE、Cline 等）均属各自服务商，本项目与其没有任何隶属、代理或合作关系。渠道能否登录、可用模型、额度与积分规则完全由服务商决定，可能随时变更或停止，本项目无法保证其持续可用。',
    },
    {
      id: 'responsibility',
      heading: '使用第三方渠道与我们无关',
      body: '你若通过本插件使用上述渠道或其他第三方服务，包括配置地址、导入凭据、安装第三方软件或登录账号，均属于你的个人行为，与本项目作者及团队无关。我们不参与、不背书、不提供支持，也不对其可用性、合规性或任何后果承担任何责任。',
    },
    {
      id: 'accounts',
      heading: '账号与凭据由你自己负责',
      body: '本插件只在你本机保存你主动导入的凭据，不会上传到任何服务器。请确保你使用这些账号的方式符合对应服务商的条款与所在地法律；由此产生的封禁、扣费、数据风险或其他损失，由使用者自行承担。',
    },
    {
      id: 'no-warranty',
      heading: '不提供任何担保',
      body: '本项目不对正确性、稳定性、适销性或特定用途适用性作任何明示或默示担保。使用本插件造成的任何直接或间接损失，作者与团队均不承担责任。请自行评估风险，并优先遵守所在地区的法律法规与服务商协议。',
    },
    {
      id: 'lawful',
      heading: '请合法合规使用',
      body: '本项目仅用于个人学习与技术研究。请勿将其用于违反服务商条款、规避授权限制、批量滥用额度或其他违法用途。因使用方式不当引发的争议、索赔或法律责任，均由使用者自行承担。',
    },
  ]),
  accept: '我已阅读并了解',
  reopen: '查看免责声明',
})

/** Whether a stored acknowledgement matches the current copy version. */
export function disclaimerAcknowledged(settings) {
  return Number(settings?.disclaimerAck) === DISCLAIMER_VERSION
}
