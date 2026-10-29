"use client";

import Image from "next/image";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Check, ImageUp, TriangleAlert } from "lucide-react";
import { useTranslations } from "next-intl";
import { PageHeader } from "@/components/app/page-header";
import { FormError } from "@/components/auth/field";
import { KYC_STEPS, KycStepper } from "@/components/kyc/kyc-stepper";
import { useKycMessage } from "@/components/kyc/use-kyc-message";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAttemptKey } from "@/lib/attempt-key";
import { COUNTRIES, countryName } from "@/lib/countries";
import { DOCUMENT_TYPES, type DocumentType, KYC_BUCKET, useOwnKyc } from "@/lib/kyc";
import {
  birthDateOk,
  cityOk,
  latestBirthDate,
  nameOk,
  PHOTO_ACCEPT,
  PHOTO_EXTENSIONS,
  type PhotoType,
  photoProblem,
} from "@/lib/kyc-rules";
import { serverAnswered } from "@/lib/rpc-error";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";

type Photo = { file: File; type: PhotoType; url: string };

const dobFormat = new Intl.DateTimeFormat("en", { dateStyle: "long", timeZone: "UTC" });
const selectClass =
  "h-11 w-full rounded-lg border border-input bg-input px-3 text-base outline-none focus-visible:ring-3 focus-visible:ring-ring/50";

// One step per screen: country and ID type, personal info, one photo, review.
// The photo is uploaded on Submit to {user_id}/{client_request_id}.{ext}, and the
// same key goes to submit_kyc, so a retried attempt reuses both.
export function KycFlow() {
  const t = useTranslations("Kyc");
  const c = useTranslations("Common");
  const router = useRouter();
  const kycMessage = useKycMessage();
  const attempt = useAttemptKey();
  const { kyc } = useOwnKyc();
  const [step, setStep] = useState(0);
  const [country, setCountry] = useState("");
  const [documentType, setDocumentType] = useState<DocumentType | null>(null);
  const [fullName, setFullName] = useState("");
  const [dob, setDob] = useState("");
  const [city, setCity] = useState("");
  const [photo, setPhoto] = useState<Photo | null>(null);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [today] = useState(() => new Date());

  // A pending submission cannot be replaced: back to the status card.
  const pending = kyc?.current?.status === "pending";
  useEffect(() => {
    if (pending) router.replace("/account/verification");
  }, [pending, router]);

  // Revoke the previous preview URL whenever the photo changes, and on leave.
  useEffect(() => () => (photo ? URL.revokeObjectURL(photo.url) : undefined), [photo]);

  if (kyc === undefined || pending) return <p className="text-sm">{c("loading")}</p>;
  if (kyc === null) return <p className="text-sm text-destructive">{c("genericError")}</p>;
  const userId = kyc.userId;

  const dobValid = birthDateOk(dob, today);
  const canContinue = [
    country !== "" && documentType !== null,
    nameOk(fullName) && dobValid && cityOk(city),
    photo !== null,
    true,
  ][step];

  function pickPhoto(file: File | undefined) {
    if (!file) return;
    const problem = photoProblem(file);
    if (problem) {
      setPhotoError(t(problem === "type" ? "errors.photoType" : "errors.photoSize"));
      return;
    }
    setPhotoError(null);
    setPhoto({ file, type: file.type as PhotoType, url: URL.createObjectURL(file) });
  }

  async function submit() {
    if (!photo || !documentType || sending) return;
    setSending(true);
    setError(null);
    const fields = { country, documentType, fullName: fullName.trim(), dob, city: city.trim() };
    const { file } = photo;
    const key = attempt.keyFor(JSON.stringify([fields, file.name, file.size, file.lastModified]));
    const path = `${userId}/${key}.${PHOTO_EXTENSIONS[photo.type]}`;
    const supabase = createClient();

    const upload = await supabase.storage.from(KYC_BUCKET).upload(path, file, { contentType: photo.type, upsert: false });
    // KeyAlreadyExists: this attempt's photo went up on an earlier try.
    const uploadCode = upload.error && "code" in upload.error ? upload.error.code : undefined;
    if (upload.error && uploadCode !== "KeyAlreadyExists") {
      setSending(false);
      setError(
        t(
          uploadCode === "EntityTooLarge"
            ? "errors.photoSize"
            : uploadCode === "InvalidMimeType"
              ? "errors.photoType"
              : "errors.uploadFailed",
        ),
      );
      return;
    }

    const { error: rpcError } = await supabase.rpc("submit_kyc", {
      p_country: fields.country,
      p_document_type: documentType,
      p_full_name: fields.fullName,
      p_date_of_birth: fields.dob,
      p_city: fields.city,
      p_photo_path: path,
      p_client_request_id: key,
    });
    if (rpcError) {
      // Without a server answer the submission may exist: keep the key for a retry.
      if (serverAnswered(rpcError)) attempt.settle();
      setSending(false);
      setError(kycMessage(rpcError));
      return;
    }
    attempt.settle();
    router.replace("/account/verification");
  }

  const docLabel = documentType ? t(`documents.${documentType}`) : "";

  return (
    <div className="mx-auto w-full max-w-[480px] space-y-5">
      <PageHeader title={t("flowTitle")} back="/account/verification" />
      <KycStepper done={step} current={step} compact />

      <section className="space-y-5 rounded-2xl border bg-card p-4">
        {step === 0 ? (
          <>
            <div className="space-y-1.5">
              <Label htmlFor="kyc-country">{t("country")}</Label>
              <select id="kyc-country" value={country} onChange={(e) => setCountry(e.target.value)} className={selectClass}>
                <option value="" disabled>
                  {t("countryPlaceholder")}
                </option>
                {COUNTRIES.map(({ code, name }) => (
                  <option key={code} value={code}>
                    {name}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <p id="kyc-doc-label" className="text-sm font-medium">
                {t("documentType")}
              </p>
              <div role="radiogroup" aria-labelledby="kyc-doc-label" className="grid gap-2">
                {DOCUMENT_TYPES.map((type) => (
                  <button
                    key={type}
                    type="button"
                    role="radio"
                    aria-checked={documentType === type}
                    onClick={() => setDocumentType(type)}
                    className={cn(
                      "flex h-12 items-center justify-between rounded-xl border px-4 text-left text-sm font-medium",
                      documentType === type ? "border-primary bg-primary/10 text-primary" : "text-foreground",
                    )}
                  >
                    {t(`documents.${type}`)}
                    {documentType === type ? <Check className="size-4" /> : null}
                  </button>
                ))}
              </div>
            </div>
          </>
        ) : null}

        {step === 1 ? (
          <>
            <div className="space-y-1.5">
              <Label htmlFor="kyc-name">{t("fullName")}</Label>
              <Input
                id="kyc-name"
                value={fullName}
                maxLength={100}
                autoComplete="name"
                className="h-11 text-base"
                aria-describedby="kyc-name-hint"
                onChange={(e) => setFullName(e.target.value)}
              />
              <p id="kyc-name-hint" className="text-xs text-muted-foreground">
                {fullName !== "" && !nameOk(fullName) ? t("invalid.fullName") : t("fullNameHint")}
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="kyc-dob">{t("dateOfBirth")}</Label>
              <Input
                id="kyc-dob"
                type="date"
                value={dob}
                min="1900-01-02"
                max={latestBirthDate(today)}
                autoComplete="bday"
                className="h-11 text-base"
                aria-invalid={dob !== "" && !dobValid}
                onChange={(e) => setDob(e.target.value)}
              />
              {dob !== "" && !dobValid ? <p className="text-xs text-destructive">{t("invalid.dateOfBirth")}</p> : null}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="kyc-city">{t("city")}</Label>
              <Input
                id="kyc-city"
                value={city}
                maxLength={80}
                autoComplete="address-level2"
                className="h-11 text-base"
                onChange={(e) => setCity(e.target.value)}
              />
            </div>
          </>
        ) : null}

        {step === 2 ? (
          <div className="space-y-3">
            <p role="note" className="flex gap-2 rounded-xl bg-muted p-3 text-sm font-medium text-foreground">
              <TriangleAlert className="mt-0.5 size-4 shrink-0" />
              {t("sampleOnly")}
            </p>
            <p className="text-sm font-medium">{t("photoLabel")}</p>
            <label
              htmlFor="kyc-photo"
              className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border border-dashed bg-muted/40 p-4 text-center focus-within:ring-3 focus-within:ring-ring/50"
            >
              {photo ? (
                <span className="relative block aspect-[4/3] w-full overflow-hidden rounded-lg bg-black/40">
                  <Image src={photo.url} alt={t("photoAlt")} fill sizes="448px" className="object-contain" />
                </span>
              ) : (
                <ImageUp className="size-8 text-muted-foreground" />
              )}
              <span className="text-sm font-medium text-primary">{photo ? t("replacePhoto") : t("choosePhoto")}</span>
              <span className="text-xs text-muted-foreground">{t("photoHint")}</span>
              <input
                id="kyc-photo"
                type="file"
                accept={PHOTO_ACCEPT}
                className="sr-only"
                onChange={(e) => {
                  pickPhoto(e.target.files?.[0]);
                  e.target.value = "";
                }}
              />
            </label>
            <FormError message={photoError} />
          </div>
        ) : null}

        {step === 3 && photo ? (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">{t("reviewIntro")}</p>
            <ReviewGroup title={t("steps.country")} onEdit={() => setStep(0)} editLabel={t("edit")}>
              <dl className="space-y-1.5">
                <Row label={t("country")} value={countryName(country)} />
                <Row label={t("documentType")} value={docLabel} />
              </dl>
            </ReviewGroup>
            <ReviewGroup title={t("steps.personal")} onEdit={() => setStep(1)} editLabel={t("edit")}>
              <dl className="space-y-1.5">
                <Row label={t("fullName")} value={fullName.trim()} />
                <Row label={t("dateOfBirth")} value={dobFormat.format(new Date(`${dob}T00:00:00Z`))} />
                <Row label={t("city")} value={city.trim()} />
              </dl>
            </ReviewGroup>
            <ReviewGroup title={t("steps.documents")} onEdit={() => setStep(2)} editLabel={t("edit")}>
              <span className="relative block aspect-[4/3] w-full overflow-hidden rounded-lg bg-black/40">
                <Image src={photo.url} alt={t("photoAlt")} fill sizes="448px" className="object-contain" />
              </span>
            </ReviewGroup>
          </div>
        ) : null}

        <FormError message={error} />
        <div className="flex gap-2">
          {step > 0 ? (
            <Button type="button" variant="secondary" className="h-11 flex-1" disabled={sending} onClick={() => setStep(step - 1)}>
              {t("back")}
            </Button>
          ) : null}
          {step < KYC_STEPS.length - 1 ? (
            <Button type="button" className="h-11 flex-1" disabled={!canContinue} onClick={() => setStep(step + 1)}>
              {t("continue")}
            </Button>
          ) : (
            <Button type="button" className="h-11 flex-1" disabled={sending} onClick={submit}>
              {sending ? t("submitting") : t("submit")}
            </Button>
          )}
        </div>
      </section>
    </div>
  );
}

function ReviewGroup({
  title,
  editLabel,
  onEdit,
  children,
}: {
  title: string;
  editLabel: string;
  onEdit: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-2 rounded-xl border p-3">
      <div className="flex items-center justify-between">
        <p className="text-sm font-semibold">{title}</p>
        <Button type="button" variant="ghost" size="xs" onClick={onEdit}>
          {editLabel}
        </Button>
      </div>
      <div className="text-sm">{children}</div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-right font-medium break-words">{value}</dd>
    </div>
  );
}
