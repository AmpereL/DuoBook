import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Save, TestTube2, Volume2 } from "lucide-react";
import { api } from "../api";

export function SpeechConfigurationPanel() {
  const queryClient = useQueryClient();
  const configuration = useQuery({ queryKey: ["speech-configuration"], queryFn: api.speechConfiguration });
  const [baseUrl, setBaseUrl] = useState("https://api.xiaomimimo.com/v1");
  const [key, setKey] = useState("");
  const [timeout, setTimeoutValue] = useState(120);
  useEffect(() => {
    if (window.location.hash === "#speech-settings") document.getElementById("speech-settings")?.scrollIntoView();
  }, []);
  useEffect(() => {
    if (configuration.data) {
      setBaseUrl(configuration.data.base_url || "https://api.xiaomimimo.com/v1");
      setTimeoutValue(configuration.data.timeout || 120);
    }
  }, [configuration.data]);
  const save = useMutation({ mutationFn: api.updateSpeechConfiguration, onSuccess: () => {
    setKey("");
    queryClient.invalidateQueries({ queryKey: ["speech-configuration"] });
  } });
  const test = useMutation({ mutationFn: api.testSpeechConfiguration });
  const body = { base_url: baseUrl, api_key: key || undefined, timeout };
  const pending = save.isPending || test.isPending;

  return (
    <section className="settings-card" aria-label="MiMo 语音连接设置" id="speech-settings">
      <div className="settings-card__heading"><span className="settings-icon"><Volume2 size={22} /></span><div><h2>MiMo 语音连接</h2><p>独立配置朗读接口和 Key，使用 mimo-v2.5-tts。解析模型的设置不受影响。</p></div></div>
      <div className="settings-fields">
        <label><span>语音 API 地址</span><input aria-label="语音 API 地址" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} autoComplete="url" /><small>普通 API Key 使用 https://api.xiaomimimo.com/v1；Token Plan 使用对应套餐地址。</small></label>
        <label><span>语音 API Key</span><input aria-label="语音 API Key" type="password" value={key} onChange={(event) => setKey(event.target.value)} placeholder={configuration.data?.configured ? "已配置，留空继续使用" : "粘贴 MiMo 语音 Key"} autoComplete="off" /><small>{window.duobookDesktop ? "桌面版保存后加密存储于本机。" : "仅保存到本机私有配置文件，不回显 Key。"}{configuration.data?.credential_source === "model" ? "当前沿用解析 Key；保存后改为独立语音配置。" : "当前使用独立语音配置。"}</small></label>
        <label><span>语音请求超时（秒）</span><input aria-label="语音请求超时（秒）" type="number" min="5" max="300" value={timeout} onChange={(event) => setTimeoutValue(Number(event.target.value) || 120)} /></label>
      </div>
      {save.error || test.error ? <p className="settings-error" role="alert">{(save.error || test.error)?.message ?? "语音配置失败"}</p> : null}
      {save.isSuccess ? <p className="settings-success"><Check size={16} />语音配置已保存。</p> : null}
      {test.isSuccess ? <p className="settings-success"><Check size={16} />{test.data.message}</p> : null}
      <div className="settings-actions">
        <button type="button" className="button button--secondary" disabled={pending} onClick={() => test.mutate(body)}><TestTube2 size={17} />{test.isPending ? "正在合成测试语音…" : "测试语音连接"}</button>
        <button type="button" className="button button--primary" disabled={pending} onClick={() => save.mutate(body)}><Save size={17} />{save.isPending ? "正在保存…" : "保存语音设置"}</button>
      </div>
    </section>
  );
}
