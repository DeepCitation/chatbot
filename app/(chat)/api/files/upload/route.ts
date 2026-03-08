import { put } from "@vercel/blob";
import { NextResponse } from "next/server";
import { z } from "zod";

import { auth } from "@/app/(auth)/auth";
import { getDeepCitationClient } from "@/lib/ai/deepcitation";

const IMAGE_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/tiff",
  "image/webp",
];

const DOCUMENT_MIME_TYPES = [
  "application/pdf",
  "application/msword", // .doc
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document", // .docx
  "application/vnd.ms-excel", // .xls
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", // .xlsx
  "application/vnd.ms-powerpoint", // .ppt
  "application/vnd.openxmlformats-officedocument.presentationml.presentation", // .pptx
];

const ALLOWED_MIME_TYPES = [...IMAGE_MIME_TYPES, ...DOCUMENT_MIME_TYPES];

// Use Blob instead of File since File is not available in Node.js environment
const FileSchema = z.object({
  file: z
    .instanceof(Blob)
    .refine((file) => file.size <= 50 * 1024 * 1024, {
      message: "File size should be less than 50MB",
    })
    .refine((file) => ALLOWED_MIME_TYPES.includes(file.type), {
      message:
        "Unsupported file type. Accepted: images (JPEG, PNG, TIFF, WebP), PDF, and Office documents (DOC, DOCX, XLS, XLSX, PPT, PPTX)",
    }),
});

export async function POST(request: Request) {
  const session = await auth();

  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (request.body === null) {
    return new Response("Request body is empty", { status: 400 });
  }

  try {
    const formData = await request.formData();
    const file = formData.get("file") as Blob;

    if (!file) {
      return NextResponse.json({ error: "No file uploaded" }, { status: 400 });
    }

    const validatedFile = FileSchema.safeParse({ file });

    if (!validatedFile.success) {
      const errorMessage = validatedFile.error.errors
        .map((error) => error.message)
        .join(", ");

      return NextResponse.json({ error: errorMessage }, { status: 400 });
    }

    // Get filename from formData since Blob doesn't have name property
    const filename = (formData.get("file") as File).name;
    const fileBuffer = await file.arrayBuffer();
    const isImage = IMAGE_MIME_TYPES.includes(file.type);

    try {
      // Private store requires private access; returned URLs include auth tokens
      const data = await put(`${filename}`, fileBuffer, {
        access: "private",
        addRandomSuffix: true,
      });

      // For non-image documents, always override contentType so the client
      // never sends raw bytes as a file part (LLMs can't process DOCX/PDF etc.)
      // Document content reaches the LLM via deepTextPromptPortion instead.
      const responseData = !isImage
        ? { ...data, contentType: "application/deepcitation" }
        : data;

      // Prepare attachment with DeepCitation if available
      const dc = getDeepCitationClient();
      if (dc) {
        try {
          const result = await dc.prepareAttachments([
            {
              file: Buffer.from(fileBuffer),
              filename,
            },
          ]);

          const attachment = result.attachments[0];
          if (attachment) {
            return NextResponse.json({
              ...responseData,
              deepCitation: {
                attachmentId: attachment.attachmentId,
                deepTextPromptPortion: result.deepTextPromptPortion,
              },
            });
          }
        } catch (dcError) {
          // Log but don't fail the upload if DeepCitation fails
          console.error("DeepCitation prepareAttachments failed:", dcError);
        }
      }

      return NextResponse.json(responseData);
    } catch (error) {
      console.error("Upload failed:", error);
      return NextResponse.json(
        { error: `Upload failed: ${error instanceof Error ? error.message : String(error)}` },
        { status: 500 }
      );
    }
  } catch (error) {
    console.error("Failed to process request:", error);
    return NextResponse.json(
      { error: `Failed to process request: ${error instanceof Error ? error.message : String(error)}` },
      { status: 500 }
    );
  }
}
