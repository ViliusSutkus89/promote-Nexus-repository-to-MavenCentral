import {debug, setSecret} from '@actions/core'
import axios, {AxiosResponse} from 'axios'
import {parseStringPromise} from 'xml2js'
import {ParseApacheRecursive} from './ParseApacheRecursive'

interface StagingProfileRepository {
  readonly profileId: string
  readonly type: string
  readonly repositoryURI: string
}

export class SonatypeClient {
  private readonly sonatypeURI: string
  private readonly repositoryId: string
  private readonly authorizationHeader: string

  private readonly initPromise: Promise<StagingProfileRepository>

  private readonly printResponseBodyInErrors: boolean

  constructor(
    uriReturnedByGradleNexusPublishPlugin: string,
    authorizationHeader: string,
    printResponseBodyInErrors: boolean,
    censorProfileId: boolean
  ) {
    this.authorizationHeader = authorizationHeader
    this.printResponseBodyInErrors = printResponseBodyInErrors

    const x = uriReturnedByGradleNexusPublishPlugin.match(
      /^(.+)repositories\/(.+)\/content\/?$/
    )
    if (x === null || 3 !== x.length) {
      throw new Error(
        `Failed to parse repository URI: ${uriReturnedByGradleNexusPublishPlugin}`
      )
    }
    this.sonatypeURI = x[1]
    debug(`SonatypeURI: ${this.sonatypeURI}`)

    this.repositoryId = x[2]
    debug(`repositoryID: ${this.repositoryId}`)

    this.initPromise = new Promise<StagingProfileRepository>(
      async (resolve, reject) => {
        const url = `${this.sonatypeURI}staging/repository/${this.repositoryId}`
        let XMLData
        try {
          const response: AxiosResponse = await axios.get(url, {
            headers: {Authorization: this.authorizationHeader}
          })
          XMLData = response.data
        } catch (err) {
          let msg = `Failed to obtain staging profile repository!\n${err.message}`
          if (printResponseBodyInErrors) {
            msg += err.response.data
          }
          reject(new Error(msg))
          return
        }

        let responseObj
        try {
          responseObj = await parseStringPromise(XMLData)
        } catch (err) {
          let msg = `${url}: xml2js parser error!`
          if (printResponseBodyInErrors) {
            msg += `\n${err.message}\n${XMLData}`
          }
          reject(new Error(msg))
          return
        }

        try {
          const repo = responseObj['stagingProfileRepository']
          if (censorProfileId) {
            setSecret(repo['profileId'][0])
          }

          const sp: StagingProfileRepository = {
            profileId: repo['profileId'][0],
            type: repo['type'][0],
            repositoryURI: repo['repositoryURI'][0]
          }

          if ('closed' !== sp.type.toLowerCase()) {
            reject(new Error('Staging repository is not closed!'))
            return
          }

          resolve(sp)
        } catch (err) {
          let msg = `${url}: Failed to parse response!`
          if (printResponseBodyInErrors) {
            msg += `\n${err.message}\n`
            msg += JSON.stringify(responseObj)
          }
          reject(new Error(msg))
        }
      }
    )
  }

  async sendPromoteRequest(): Promise<void> {
    return new Promise<void>(async (resolve, reject) => {
      let sp: StagingProfileRepository
      try {
        sp = await this.initPromise
      } catch (err) {
        reject(err)
        return
      }

      const url = `${this.sonatypeURI}staging/profiles/${sp.profileId}/promote`
      const POSTData = `<promoteRequest><data><stagedRepositoryId>${this.repositoryId}111</stagedRepositoryId></data></promoteRequest>`
      const options = {
        headers: {
          Authorization: this.authorizationHeader,
          'Content-Type': 'application/xml',
          'Content-Length': POSTData.length
        }
      }

      try {
        await axios.post(url, POSTData, options)
        resolve()
      } catch (err) {
        let msg = `Failed to send promote request!\n${err.message}`
        if (this.printResponseBodyInErrors) {
          msg += err.response.data
        }
        reject(new Error(msg))
      }
    })
  }

  async obtainArtifactURLs(mavenCentralURL: string): Promise<string[]> {
    return new Promise<string[]>(async (resolve, reject) => {
      let sp: StagingProfileRepository
      try {
        sp = await this.initPromise
      } catch (err) {
        reject(err)
        return
      }

      try {
        const URLs: string[] = await ParseApacheRecursive(sp.repositoryURI)

        if (!mavenCentralURL.endsWith('/')) {
          mavenCentralURL += '/'
        }

        const URLsRewritten = URLs.map(artifactURL => {
          if (!artifactURL.startsWith(sp.repositoryURI)) {
            throw new Error(
              `Invalid URL received from Sonatype: ${artifactURL}`
            )
          }

          artifactURL = artifactURL.substr(sp.repositoryURI.length)
          if (artifactURL.startsWith('/')) {
            artifactURL = artifactURL.substr(1)
          }

          return mavenCentralURL + artifactURL
        })
        resolve(URLsRewritten)
      } catch (err) {
        const msg = `Failed to obtain final file list\n${err.message}`
        reject(new Error(msg))
        return
      }
    })
  }
}
