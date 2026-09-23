// Only fixed public messages leave the checkup boundary. Never echo provider errors.
export function publicCheckupError(error) {
  if (error?.code === 'sexual-content') return {status:422,code:'sexual-content',message:'This website cannot be checked because NSFW sexual imagery was detected in the sampled page.'};
  if (error?.code === 'content-screening-unavailable') return {status:503,code:'content-screening-unavailable',message:'The image content check could not finish. Please try again. This does not mean the website contains sexual content.'};
  return {status:500,message:'Something went wrong during the checkup. Please try again.'};
}
