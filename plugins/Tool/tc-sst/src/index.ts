import { Context, Schema, Logger, Session, Element } from 'koishi'
import Sst from '@initencounter/sst'
import { } from 'koishi-plugin-adapter-onebot'
import { spawn } from 'child_process'
import { } from 'koishi-plugin-ffmpeg'
import * as tencentcloud from "tencentcloud-sdk-nodejs-asr";
const AsrClient = tencentcloud.asr.v20190614.Client;

export const name = 'tc-sst'
export const logger = new Logger(name)

class TcSst extends Sst {
  static inject = {
    optional: ['ffmpeg']
  }
  client: any
  pluginConfig: TcSst.Config
  constructor(ctx: Context, config: TcSst.Config) {
    super(ctx)
    this.pluginConfig = config
    const clientConfig = {
      credential: {
        secretId: config.AK_W,
        secretKey: config.SK_W,
      },
      region: config.region,
      profile: {
        httpProfile: {
          endpoint: config.endpoint,
        },
      },
    };
    // 实例化要请求产品的client对象,clientProfile是可选的
    this.client = new AsrClient(clientConfig);
    ctx.i18n.define('zh', require('./locales/zh'));
    if (!config.auto_rcg) return
    ctx.middleware(async (session, next) => {
      let text: string = await this.audio2text(session)
      if (text === '') {
        text = session.text('sst.messages.louder')
      }
      return text
    })
  }
  async audio2text(session: Session): Promise<string> {
    let audioElementIndex = null
    for (let i = 0; i < session.elements.length; i++) {
      if (session.elements[i].type === "audio" || session.elements[i].type === "record") {
        audioElementIndex = i
        i = session.elements.length
      }
    }
    if (audioElementIndex === null) {
      return 'e04659269e105f3984e7a09ae6e0fa98da8aec5a'
    }
    const record = await this.getRecordBase64(session, session.elements[audioElementIndex])
    if (record.reason) {
      return record.reason
    }
    const duration = await this.callFFmpeg(this.ctx, record.base64)
    if (duration < 60) {
      return await this.callSentenceRecognition(record)
    }
    const taskId: string = await this.create_task(record)
    return await this.get_res(taskId)
  }

  private async callSentenceRecognition(record: TcSst.RecordResult): Promise<string> {
    const params = {
      EngSerViceType: this.pluginConfig.EngSerViceType,
      SourceType: 1,
      VoiceFormat: record.format,
      Data: record.base64,
      ConvertNumMode: 1,
    };
    const res: TcSst.ASRResponse = await this.client.SentenceRecognition(params)
    return res.Result
  }
  private async getRecordBase64(session: Session, audioElement: Element): Promise<TcSst.RecordResult> {
    switch (session.platform) {
      case 'onebot':
        const file = await session.onebot.getRecord(audioElement.attrs.file, 'wav') as TcSst.RecordOneBot
        if (!file.base64) {
          return { reason: 'onebot 平台未开启 enableLocalFile2Url' }
        }
        return { base64: file.base64, format: 'wav' }
      case 'telegram':
        if (!audioElement.attrs.src) {
          return { reason: 'telegram 平台获取base64失败' }
        }
        return { base64: audioElement.attrs.src.split(',')[1], format: 'ogg-opus' }
      case 'discord':
        if (!audioElement.attrs.src) {
          return { reason: 'discord 平台获取语音url失败' }
        }
        const base64 = Buffer.from(await this.ctx.http.get(audioElement.attrs.src)).toString('base64')
        return { base64: base64, format: 'ogg-opus' }
      default:
        return { reason: '暂未支持该平台，请拷打开发者' }
    }
  }
  private async callFFmpeg(ctx: Context, base64: string): Promise<number> {
    const executable = ctx?.ffmpeg?.executable ?? "ffmpeg"
    const child = spawn(executable, ["-i", '-', '-f', 'null', '-'], { stdio: ['pipe'] });
    child.stdin.write(Buffer.from(base64, 'base64'));
    child.stdin.end();
    return new Promise<number>((resolve, reject) => {
      let buffer = ""
      child.stderr.on('data', data => buffer += data.toString())
      child.stdout.on('close', () => {
        const timeMatch = buffer.match(/time=(\d{2}):(\d{2}):(\d{2})\.(\d{2})/)
        if (timeMatch) {
          const hours = parseInt(timeMatch[1], 10);
          const minutes = parseInt(timeMatch[2], 10);
          const seconds = parseInt(timeMatch[3], 10);
          const milliseconds = parseInt(timeMatch[4], 10) * 10;

          // 转换成秒
          const durationInSeconds = hours * 3600 + minutes * 60 + seconds + milliseconds / 1000;
          resolve(durationInSeconds);
        }
        resolve(0)
      })
      child.stdout.on('error', reject)
    })
  }
  private sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms))
  }
  private async create_task(record: TcSst.RecordResult): Promise<string> {
    const params = {
      EngineModelType: this.pluginConfig.EngSerViceType,
      ChannelNum: 1,
      ResTextFormat: 0,
      SourceType: 1,
      Data: record.base64,
      ConvertNumMode: 1,
    };
    const res = (await this.client.CreateRecTask(params)).Data.TaskId
    return res
  }
  private async get_res(taskId: string): Promise<string> {
    const params = {
      "TaskId": taskId
    };
    let res: TcSst.Task_result = await this.client.DescribeTaskStatus(params)
    while (res.Data.StatusStr == 'waiting' || res.Data.StatusStr == 'doing') {
      await this.sleep(618)
      res = await this.client.DescribeTaskStatus(params)
    }
    const segment_text: string[] = (res.Data.Result + '\n').split('\n')
    let text: string = ''
    for (var i of segment_text) {
      const id: number = i.indexOf(' ')
      if (id > -1) {
        text += i.slice(id, i.length)
      }
    }
    return text
  }
}
namespace TcSst {
  export const usage = `
## 使用说明
启用前请前往 <a style="color:blue" href="https://cloud.tencent.com/product/asr">腾讯云</a>创建应用，<br>
再到<a style="color:blue" href="https://console.cloud.tencent.com/cam/capi">腾讯云控制台</a> 进行获取密钥
只适配了QQ平台,其他平台兼容性未知
`
  export interface Config {
    AK_W: string
    SK_W: string
    endpoint: string
    region: string
    auto_rcg: boolean
    EngSerViceType: '8k_zh' | '8k_en' | '16k_zh' | '16k_zh-PY' | '16k_zh_medical' | '16k_en' | '16k_yue' | '16k_ja' | '16k_ko' | '16k_vi' | '16k_ms' | '16k_id' | '16k_fil' | '16k_th' | '16k_pt' | '16k_tr' | '16k_ar' | '16k_es' | '16k_hi' | '16k_fr' | '16k_de' | '16k_zh_dialect'
  }

  export interface RecordOneBot {
    file: string
    url: string
    file_size: string
    file_name: string
    base64?: string
  }

  export interface RecordResult {
    reason?: string
    base64?: string
    format?: string
    AudioDuration?: number
  }

  export interface Result {
    input: Session
    output?: string
  }
  export interface Task_result {
    RequestId: string
    Data: {
      TaskId: number
      Status: number
      StatusStr: string
      AudioDuration: number
      Result: string
      ResultDetail: null,
      ErrorMsg: string
    }
  }

  export interface ASRResponse {
    AudioDuration: number
    RequestId: string
    Result: string
    WordList: null
    WordSize: number
  }

  export const Config: Schema<Config> = Schema.object({
    AK_W: Schema.string().description('语音识别AK'),
    SK_W: Schema.string().description('语音识别SK'),
    auto_rcg: Schema.boolean().default(false).description('自动语音转文字,作为服务启用时建议关闭'),
    endpoint: Schema.string().default('asr.tencentcloudapi.com').description('腾讯云域名'),
    region: Schema.string().default('ap-guangzhou').description('区域'),
    EngSerViceType: Schema.union(
      [
        Schema.const('8k_zh').description('中文电话通用'),
        Schema.const('8k_en').description('英文电话通用'),
        Schema.const('16k_zh').description('中文通用'),
        Schema.const('16k_zh-PY').description('中英粤'),
        Schema.const('16k_zh_medical').description('中文医疗'),
        Schema.const('16k_en').description('英语'),
        Schema.const('16k_yue').description('粤语'),
        Schema.const('16k_ja').description('日语'),
        Schema.const('16k_ko').description('韩语'),
        Schema.const('16k_vi').description('越南语'),
        Schema.const('16k_ms').description('马来语'),
        Schema.const('16k_id').description('印度尼西亚语'),
        Schema.const('16k_fil').description('菲律宾语'),
        Schema.const('16k_th').description('泰语'),
        Schema.const('16k_pt').description('葡萄牙语'),
        Schema.const('16k_tr').description('土耳其语'),
        Schema.const('16k_ar').description('阿拉伯语'),
        Schema.const('16k_es').description('西班牙语'),
        Schema.const('16k_hi').description('印地语'),
        Schema.const('16k_fr').description('法语'),
        Schema.const('16k_de').description('德语'),
        Schema.const('16k_zh_dialect').description('多方言，支持23种方言（上海话、四川话、武汉话、贵阳话、昆明话、西安话、郑州话、太原话、兰州话、银川话、西宁话、南京话、合肥话、南昌话、长沙话、苏州话、杭州话、济南话、天津话、石家庄话、黑龙江话、吉林话、辽宁话）'),
      ]
    ).default('16k_zh').description('引擎模型类型'),
  })

}

export default TcSst


