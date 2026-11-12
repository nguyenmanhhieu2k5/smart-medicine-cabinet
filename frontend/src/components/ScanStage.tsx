import clsx from "clsx";
import { Camera, CameraOff, Image as ImageIcon, Keyboard, LoaderCircle, Power, Video } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { Select } from "@/components/Form";
import { useCamera } from "@/hooks/useCamera";
import { useT } from "@/i18n";
import { api } from "@/services/api";
import { errorMessage, useSettings, useUpdateSettings } from "@/services/queries";
import { toast } from "@/stores/toast";
import { useUiStore } from "@/stores/ui";

function Corner({ position }: { position: "tl" | "tr" | "bl" | "br" }) {
  const map = {
    tl: "left-0 top-0 border-l-[4px] border-t-[4px] rounded-tl-[26px]",
    tr: "right-0 top-0 border-r-[4px] border-t-[4px] rounded-tr-[26px]",
    bl: "left-0 bottom-0 border-l-[4px] border-b-[4px] rounded-bl-[26px]",
    br: "right-0 bottom-0 border-r-[4px] border-b-[4px] rounded-br-[26px]",
  };
  return <span aria-hidden className={clsx("absolute size-[64px] border-white/95 drop-shadow-[0_1px_3px_rgba(17,27,57,0.35)] short:size-12", map[position])} />;
}

interface ScanStageProps {
  /** Tự bật camera khi vào trang (trang Quét thuốc). Trang chủ để người dùng chủ động bật. */
  autoStart?: boolean;
  previewClassName?: string;
  caption: ReactNode;
}

/**
 * Khu vực nhận diện: khung camera lớn có bốn góc quét, nút camera tròn nổi bật ở giữa
 * và hai nút phụ đối xứng (Chọn ảnh · Nhập thủ công). Dùng chung cho Trang chủ và Quét thuốc.
 */
export function ScanStage({ autoStart = false, previewClassName, caption }: ScanStageProps) {
  const t = useT();
  const navigate = useNavigate();
  const settings = useSettings();
  const saveSettings = useUpdateSettings(true);
  const openSearch = useUiStore((state) => state.openCatalogSearch);
  const camera = useCamera(settings.data?.settings.camera_device_id);
  const guideRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const autoStarted = useRef(false);
  const { start } = camera;

  useEffect(() => {
    if (autoStart && settings.isSuccess && !autoStarted.current) {
      autoStarted.current = true;
      void start(settings.data.settings.camera_device_id);
    }
  }, [autoStart, settings.isSuccess, settings.data, start]);

  const submit = useCallback(
    async (image: Blob, source: "camera" | "upload", crop?: number[] | null) => {
      setBusy(true);
      try {
        const job = await api.ocrSubmit(image, source, crop);
        navigate(`/scan/result/${job.id}`);
      } catch (error) {
        toast.error(t("Không gửi được ảnh để nhận diện"), errorMessage(error));
        setBusy(false);
      }
    },
    [navigate, t],
  );

  const onMainButton = async () => {
    if (busy) return;
    if (camera.status !== "active") {
      await camera.start();
      return;
    }
    setBusy(true);
    const shot = await camera.capture();
    if (!shot) {
      setBusy(false);
      toast.error(t("Không chụp được khung hình"), t("Hãy thử lại sau khi hình ảnh camera hiển thị."));
      return;
    }
    await submit(shot.blob, "camera", shot.crop);
  };

  const onFile = (file: File | undefined) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      toast.error(t("File không phải hình ảnh"), t("Hãy chọn ảnh JPEG, PNG, WebP hoặc BMP."));
      return;
    }
    void submit(file, "upload", null);
  };

  const active = camera.status === "active";
  const mainLabel = busy ? t("Đang gửi ảnh…") : active ? t("Chụp và nhận diện") : t("Bật camera");
  const currentLabel = camera.devices.find((d) => d.deviceId === camera.deviceId)?.label;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        className={clsx(
          "relative w-full flex-1 overflow-hidden rounded-[22px] bg-gradient-to-br from-[#e9edf3] via-[#f3f5f8] to-[#dfe5ee] dark:from-[#1b243b] dark:via-[#182036] dark:to-[#111a2e]",
          previewClassName,
        )}
      >
        <video ref={camera.videoRef} muted playsInline className={clsx("absolute inset-0 size-full object-cover transition-opacity duration-300", active ? "opacity-100" : "opacity-0")} />

        {!active && (
          <div className="absolute inset-y-0 left-1/2 flex w-[56%] -translate-x-1/2 flex-col items-center justify-center text-center max-xl:w-[62%]">
            {camera.status === "starting" ? (
              <>
                <LoaderCircle size={34} className="animate-spin text-primary" />
                <p className="mt-4 text-sm font-medium text-muted">{t("Đang mở camera…")}</p>
              </>
            ) : camera.status === "error" ? (
              <>
                <span className="inline-flex size-16 items-center justify-center rounded-3xl bg-danger-soft text-danger"><CameraOff size={30} strokeWidth={1.6} /></span>
                <p className="mt-4 font-display text-[17px] font-bold text-navy">{t("Camera không hoạt động")}</p>
                <p className="mt-1.5 max-w-sm text-sm text-muted">{t(camera.error ?? "")}</p>
                <p className="mt-1 text-[13px] text-muted">{t("Bạn vẫn có thể chọn ảnh từ máy tính hoặc nhập thủ công.")}</p>
              </>
            ) : (
              <>
                <span className="inline-flex size-16 items-center justify-center rounded-3xl bg-surface/80 text-primary shadow-card short:size-12 short:rounded-2xl"><Video size={30} strokeWidth={1.6} className="short:scale-75" /></span>
                <p className="mt-4 font-display text-[17px] font-bold text-navy short:mt-2">{t("Camera chưa bật")}</p>
                <p className="mt-1.5 max-w-sm text-sm text-muted short:mt-0.5 short:text-[13px]">{t("Nhấn nút camera bên dưới, rồi đưa hộp hoặc vỉ thuốc vào giữa khung hình.")}</p>
              </>
            )}
          </div>
        )}

        {/* Khung quét với bốn góc */}
        <div ref={guideRef} className="pointer-events-none absolute inset-x-[19%] inset-y-[13%] max-xl:inset-x-[14%]">
          <Corner position="tl" /><Corner position="tr" /><Corner position="bl" /><Corner position="br" />
          {(busy || camera.status === "starting") && active && (
            <span aria-hidden className="scanline absolute inset-x-3 top-2 h-0.5 rounded-full bg-primary shadow-[0_0_16px_2px_rgba(8,120,249,0.65)]" style={{ ["--scan-distance" as string]: `${(guideRef.current?.clientHeight ?? 260) - 16}px` }} />
          )}
        </div>

        {active && (
          <span className="absolute left-5 top-5 z-10 inline-flex max-w-[60%] items-center gap-2 truncate rounded-full bg-[#111b39]/55 px-3.5 py-2 text-[12.5px] font-medium text-white backdrop-blur">
            <span className="size-2 rounded-full bg-[#3ddc97]" />
            {`${t("Camera trực tiếp")}${currentLabel ? ` · ${currentLabel}` : ""}`}
          </span>
        )}

        {active && (
          <div className="absolute right-5 top-4 z-10 flex items-center gap-2">
            {camera.devices.length > 1 && (
              <Select
                aria-label={t("Chọn camera")} value={camera.deviceId ?? ""} className="!h-9 max-w-[220px] !rounded-full !bg-surface/90 !py-0 !text-[12.5px] backdrop-blur"
                onChange={(event) => {
                  const id = event.target.value;
                  void camera.start(id);
                  saveSettings.mutate({ camera_device_id: id });
                }}
              >
                {camera.devices.map((device) => <option key={device.deviceId} value={device.deviceId}>{device.label}</option>)}
              </Select>
            )}
            <button type="button" onClick={camera.stop} aria-label={t("Tắt camera")} title={t("Tắt camera")} className="inline-flex size-9 items-center justify-center rounded-full bg-surface/90 text-navy backdrop-blur transition hover:text-danger">
              <Power size={16} />
            </button>
          </div>
        )}
      </div>

      <div className="flex items-center justify-center gap-[72px] pt-5 short:gap-14 short:pt-3">
        <input ref={fileRef} type="file" accept="image/*" className="hidden" data-testid="scan-file-input" onChange={(event) => { onFile(event.target.files?.[0]); event.target.value = ""; }} />
        <SideAction icon={ImageIcon} label={t("Chọn ảnh")} onClick={() => fileRef.current?.click()} disabled={busy} />
        <button
          type="button" onClick={onMainButton} disabled={busy || camera.status === "starting"} aria-label={mainLabel} title={mainLabel} data-testid="scan-main-button"
          className="group relative inline-flex size-[108px] items-center justify-center rounded-full outline-offset-4 transition-transform duration-200 hover:scale-[1.03] active:scale-95 disabled:opacity-70 short:size-[84px]"
        >
          <span aria-hidden className="absolute inset-0 rounded-full bg-primary/12 ring-1 ring-primary/10" />
          <span className="relative inline-flex size-[90px] items-center justify-center rounded-full bg-gradient-to-b from-[#3aa0fb] to-[#0872f5] text-white shadow-[0_14px_30px_rgba(8,120,249,0.38)] short:size-[70px]">
            {busy ? <LoaderCircle size={34} className="animate-spin" /> : <Camera size={36} strokeWidth={1.9} className="short:scale-90" />}
          </span>
        </button>
        <SideAction icon={Keyboard} label={t("Nhập thủ công")} onClick={() => openSearch()} disabled={busy} />
      </div>
      <div className="pt-3 text-center short:pt-2">{caption}</div>
    </div>
  );
}

function SideAction({ icon: Icon, label, onClick, disabled }: { icon: typeof Camera; label: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} aria-label={label} title={label}
      className="inline-flex size-[52px] items-center justify-center rounded-full bg-tile text-muted transition duration-150 hover:bg-primary-soft hover:text-primary disabled:opacity-50">
      <Icon size={22} strokeWidth={1.7} />
    </button>
  );
}
