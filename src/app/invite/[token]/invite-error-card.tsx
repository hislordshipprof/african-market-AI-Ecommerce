"use client";

import { XCircle } from "lucide-react";
import {
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { StoryCard, StorySurface } from "@/components/story-surface/story-surface";

export function InviteErrorCard({ message }: { message: string }) {
  return (
    <StorySurface>
      <StoryCard className="text-center">
        <CardHeader>
          <div className="mx-auto mb-2 flex size-12 items-center justify-center rounded-full bg-destructive/10">
            <XCircle className="size-6 text-destructive" />
          </div>
          <CardTitle className="text-lg">Invalid Invitation</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">{message}</p>
        </CardContent>
      </StoryCard>
    </StorySurface>
  );
}
