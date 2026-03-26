import { encode } from "gpt-tokenizer";

export type ChunkingConfig = {
  targetTokens: number;
  maxTokens: number;
  overlapTokens: number;
  oversizedParagraphTargetTokens: number;
};

export type ChunkResult = {
  chunkText: string;
  tokenCount: number;
  charCount: number;
  startParagraphIndex: number;
  endParagraphIndex: number;
};

type ParagraphUnit = {
  text: string;
  tokenCount: number;
  sourceParagraphIndex: number;
};

export const DEFAULT_CHUNKING_CONFIG: ChunkingConfig = {
  targetTokens: 700,
  maxTokens: 900,
  overlapTokens: 120,
  oversizedParagraphTargetTokens: 700
};

export function normalizeDocumentText(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function splitParagraphs(text: string): string[] {
  return normalizeDocumentText(text)
    .split(/\n\s*\n/g)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
}

export function countTokens(text: string): number {
  return encode(text).length;
}

function splitOversizedParagraph(paragraph: string, paragraphIndex: number, config: ChunkingConfig): ParagraphUnit[] {
  const sentences = paragraph.match(/[^.!?]+[.!?]+|\S.+$/g)?.map((sentence) => sentence.trim()).filter(Boolean) ?? [paragraph];
  const units: ParagraphUnit[] = [];
  let currentSentences: string[] = [];
  let currentTokens = 0;

  for (const sentence of sentences) {
    const sentenceTokens = countTokens(sentence);
    const proposedTokens = currentTokens === 0
      ? sentenceTokens
      : countTokens(`${currentSentences.join(" ")} ${sentence}`);

    if (currentSentences.length > 0 && proposedTokens > config.maxTokens) {
      const text = currentSentences.join(" ");
      units.push({
        text,
        tokenCount: countTokens(text),
        sourceParagraphIndex: paragraphIndex
      });
      currentSentences = [sentence];
      currentTokens = sentenceTokens;
      continue;
    }

    currentSentences.push(sentence);
    currentTokens = proposedTokens;
  }

  if (currentSentences.length > 0) {
    const text = currentSentences.join(" ");
    units.push({
      text,
      tokenCount: countTokens(text),
      sourceParagraphIndex: paragraphIndex
    });
  }

  return units;
}

function paragraphUnits(paragraphs: string[], config: ChunkingConfig): ParagraphUnit[] {
  return paragraphs.flatMap((paragraph, index) => {
    const tokenCount = countTokens(paragraph);
    if (tokenCount <= config.maxTokens) {
      return [{ text: paragraph, tokenCount, sourceParagraphIndex: index }];
    }

    return splitOversizedParagraph(paragraph, index, config);
  });
}

function buildOverlap(units: ParagraphUnit[], overlapTokens: number): ParagraphUnit[] {
  const overlap: ParagraphUnit[] = [];
  let total = 0;

  for (let index = units.length - 1; index >= 0; index -= 1) {
    overlap.unshift(units[index]);
    total += units[index].tokenCount;
    if (total >= overlapTokens) {
      break;
    }
  }

  return overlap;
}

function finalizeChunk(units: ParagraphUnit[]): ChunkResult {
  const chunkText = units.map((unit) => unit.text).join("\n\n");
  return {
    chunkText,
    tokenCount: countTokens(chunkText),
    charCount: chunkText.length,
    startParagraphIndex: units[0].sourceParagraphIndex,
    endParagraphIndex: units[units.length - 1].sourceParagraphIndex
  };
}

export function chunkDocument(text: string, config: ChunkingConfig = DEFAULT_CHUNKING_CONFIG): ChunkResult[] {
  const paragraphs = splitParagraphs(text);
  const units = paragraphUnits(paragraphs, config);
  const chunks: ChunkResult[] = [];

  let current: ParagraphUnit[] = [];
  let currentTokens = 0;

  for (const unit of units) {
    const proposedTokens = currentTokens === 0
      ? unit.tokenCount
      : countTokens(`${current.map((item) => item.text).join("\n\n")}\n\n${unit.text}`);

    if (current.length > 0 && proposedTokens > config.maxTokens) {
      chunks.push(finalizeChunk(current));
      current = buildOverlap(current, config.overlapTokens);
      currentTokens = current.reduce((sum, item) => sum + item.tokenCount, 0);
    }

    current.push(unit);
    currentTokens = currentTokens === 0 ? unit.tokenCount : countTokens(current.map((item) => item.text).join("\n\n"));

    if (currentTokens >= config.targetTokens) {
      chunks.push(finalizeChunk(current));
      current = buildOverlap(current, config.overlapTokens);
      currentTokens = current.reduce((sum, item) => sum + item.tokenCount, 0);
    }
  }

  if (current.length > 0) {
    const lastChunk = finalizeChunk(current);
    const duplicateLastChunk = chunks[chunks.length - 1]?.chunkText === lastChunk.chunkText;
    if (!duplicateLastChunk) {
      chunks.push(lastChunk);
    }
  }

  return chunks;
}
